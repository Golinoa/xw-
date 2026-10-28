ALTER TABLE public.organization_members
ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled'));


CREATE TABLE public.organization_role_permissions (
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'finance')),
  permission text NOT NULL CHECK (length(btrim(permission)) > 0),
  PRIMARY KEY (role, permission)
);


INSERT INTO
  public.organization_role_permissions (role, permission)
VALUES
  ('admin', 'organization.read'),
  ('admin', 'member.manage'),
  ('admin', 'settings.manage'),
  ('admin', 'audit.read'),
  ('operator', 'organization.read'),
  ('finance', 'organization.read'),
  ('finance', 'audit.read');


CREATE TABLE public.organization_role_data_scopes (
  role text PRIMARY KEY CHECK (role IN ('admin', 'operator', 'finance')),
  data_scope text NOT NULL CHECK (data_scope IN ('own', 'all'))
);


INSERT INTO
  public.organization_role_data_scopes (role, data_scope)
VALUES
  ('admin', 'all'),
  ('operator', 'own'),
  ('finance', 'all');


ALTER TABLE public.organization_role_permissions ENABLE ROW LEVEL SECURITY;


ALTER TABLE public.organization_role_data_scopes ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON public.organization_role_permissions,
public.organization_role_data_scopes
FROM
  public,
  anon,
  authenticated;


GRANT
SELECT
  ON public.organization_role_permissions,
  public.organization_role_data_scopes TO service_role;


CREATE TABLE public.organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  normalized_email text NOT NULL CHECK (normalized_email = lower(btrim(normalized_email))),
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'finance')),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'accepted', 'revoked', 'expired')
  ),
  invited_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
  accepted_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);


CREATE UNIQUE INDEX organization_invitations_pending_email_idx ON public.organization_invitations (organization_id, normalized_email)
WHERE
  status = 'pending';


CREATE INDEX organization_invitations_pending_expiry_idx ON public.organization_invitations (expires_at)
WHERE
  status = 'pending';


ALTER TABLE public.organization_invitations ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON public.organization_invitations
FROM
  public,
  anon,
  authenticated;


GRANT ALL ON public.organization_invitations TO service_role;


DROP POLICY organization_members_select_self ON public.organization_members;


CREATE POLICY organization_members_select_self ON public.organization_members FOR
SELECT
  TO authenticated USING (
    (
      NOT coalesce(
        (
          nullif(current_setting('request.headers', TRUE), '')::pg_catalog.jsonb
        ) ? 'x-organization-id',
        FALSE
      )
      AND user_id = (
        SELECT
          auth.uid ()
      )
      AND status = 'active'
    )
    OR organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


DROP POLICY organizations_select_member_self ON public.organizations;


CREATE POLICY organizations_select_member_self ON public.organizations FOR
SELECT
  TO authenticated USING (
    id = (
      SELECT
        public.current_organization_id ()
    )
    OR (
      NOT coalesce(
        (
          nullif(current_setting('request.headers', TRUE), '')::pg_catalog.jsonb
        ) ? 'x-organization-id',
        FALSE
      )
      AND EXISTS (
        SELECT
          1
        FROM
          public.organization_members AS member
        WHERE
          member.organization_id = organizations.id
          AND member.user_id = (
            SELECT
              auth.uid ()
          )
          AND member.status = 'active'
      )
    )
  );


CREATE OR REPLACE FUNCTION public.current_organization_id () RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  request_headers pg_catalog.jsonb;
  selected_organization_id uuid;
BEGIN
  request_headers := nullif(current_setting('request.headers', true), '')::pg_catalog.jsonb;
  BEGIN
    selected_organization_id := (request_headers ->> 'x-organization-id')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN NULL;
  END;
  IF selected_organization_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_members AS member
    WHERE member.user_id = (SELECT auth.uid())
      AND member.organization_id = selected_organization_id
      AND member.status = 'active'
  ) THEN
    RETURN NULL;
  END IF;
  RETURN selected_organization_id;
EXCEPTION WHEN invalid_text_representation THEN
  RETURN NULL;
END;
$$;


CREATE OR REPLACE FUNCTION public.has_permission (permission text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.organization_members AS member
    JOIN public.organization_role_permissions AS grant_row ON grant_row.role = member.role
    WHERE member.user_id = (SELECT auth.uid())
      AND member.organization_id = (SELECT public.current_organization_id())
      AND member.status = 'active'
    AND grant_row.permission = $1
  );
$$;


CREATE OR REPLACE FUNCTION public.current_data_scope () RETURNS text LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT scope.data_scope
  FROM public.organization_members AS member
  JOIN public.organization_role_data_scopes AS scope ON scope.role = member.role
  WHERE member.user_id = (SELECT auth.uid())
    AND member.organization_id = (SELECT public.current_organization_id())
    AND member.status = 'active'
  LIMIT 1;
$$;


CREATE OR REPLACE FUNCTION public.get_current_auth_context (requested_organization_id uuid DEFAULT NULL) RETURNS TABLE (
  organization_id uuid,
  role text,
  permissions TEXT[],
  data_scope text
) LANGUAGE sql STABLE SECURITY DEFINER
SET
  search_path = '' AS $$
  SELECT member.organization_id,
    member.role,
    coalesce(array_agg(grant_row.permission ORDER BY grant_row.permission)
      FILTER (WHERE grant_row.permission IS NOT NULL), ARRAY[]::text[]),
    scope.data_scope
  FROM public.organization_members AS member
  JOIN public.organization_role_data_scopes AS scope ON scope.role = member.role
  LEFT JOIN public.organization_role_permissions AS grant_row ON grant_row.role = member.role
  WHERE member.user_id = (SELECT auth.uid())
    AND member.status = 'active'
    AND (requested_organization_id IS NULL OR member.organization_id = requested_organization_id)
  GROUP BY member.organization_id, member.role, scope.data_scope
  ORDER BY member.organization_id
  LIMIT 1;
$$;


CREATE OR REPLACE FUNCTION public.create_organization_invitation (
  requested_organization_id uuid,
  requested_email text,
  requested_role text
) RETURNS TABLE (
  invitation_id uuid,
  invitation_status text,
  invitation_expires_at timestamptz,
  invitation_created boolean
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  normalized text := lower(btrim(requested_email));
  created_id uuid;
  expires_at_value timestamptz;
  invitation_role text;
  created_new boolean := false;
BEGIN
  IF caller_id IS NULL OR requested_organization_id IS DISTINCT FROM (SELECT public.current_organization_id())
    OR NOT (SELECT public.has_permission('member.manage')) THEN
    RAISE EXCEPTION 'Membership management is not permitted' USING ERRCODE = '42501';
  END IF;
  IF normalized = '' OR normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    OR requested_role IS NULL OR requested_role NOT IN ('admin', 'operator', 'finance') THEN
    RAISE EXCEPTION 'Invalid invitation' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organization_invitations (organization_id, normalized_email, role, invited_by)
  VALUES (requested_organization_id, normalized, requested_role, caller_id)
  ON CONFLICT (organization_id, normalized_email) WHERE status = 'pending' DO NOTHING
  RETURNING id, organization_invitations.expires_at INTO created_id, expires_at_value;

  IF created_id IS NULL THEN
    SELECT invitation.id, invitation.expires_at, invitation.role
      INTO created_id, expires_at_value, invitation_role
    FROM public.organization_invitations AS invitation
    WHERE invitation.organization_id = requested_organization_id
      AND invitation.normalized_email = normalized AND invitation.status = 'pending';
    IF invitation_role <> requested_role THEN
      RAISE EXCEPTION 'An invitation for this email already exists' USING ERRCODE = '23505';
    END IF;
  ELSE
    created_new := true;
    INSERT INTO public.audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
    VALUES (requested_organization_id, caller_id, 'member.invited', 'organization_invitation', created_id,
      jsonb_build_object('role', requested_role));
  END IF;

  RETURN QUERY SELECT created_id, 'pending'::text, expires_at_value, created_new;
END;
$$;


CREATE OR REPLACE FUNCTION public.accept_organization_invitation (requested_invitation_id uuid) RETURNS TABLE (organization_id uuid, membership_role text) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  caller_email text;
  invitation public.organization_invitations%ROWTYPE;
BEGIN
  IF caller_id IS NULL THEN
    RAISE EXCEPTION 'Authentication is required' USING ERRCODE = '28000';
  END IF;
  SELECT lower(btrim(auth_user.email)) INTO caller_email
  FROM auth.users AS auth_user
  WHERE auth_user.id = caller_id AND auth_user.email_confirmed_at IS NOT NULL;
  IF caller_email IS NULL THEN
    RAISE EXCEPTION 'A verified email is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO invitation FROM public.organization_invitations
  WHERE id = requested_invitation_id FOR UPDATE;
  IF invitation.id IS NULL OR invitation.status <> 'pending' OR invitation.expires_at <= now()
    OR invitation.normalized_email <> caller_email THEN
    RAISE EXCEPTION 'Invitation is unavailable' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.organization_members (organization_id, user_id, role, status)
  VALUES (invitation.organization_id, caller_id, invitation.role, 'active')
  ON CONFLICT ON CONSTRAINT organization_members_organization_id_user_id_key DO UPDATE
    SET role = EXCLUDED.role, status = 'active';
  UPDATE public.organization_invitations SET status = 'accepted', accepted_by = caller_id
  WHERE id = invitation.id;
  INSERT INTO public.audit_events (organization_id, actor_id, action, entity_type, entity_id)
  VALUES (invitation.organization_id, caller_id, 'member.invitation_accepted', 'organization_invitation', invitation.id);
  RETURN QUERY SELECT invitation.organization_id, invitation.role;
END;
$$;


CREATE OR REPLACE FUNCTION public.update_organization_member (
  requested_organization_id uuid,
  requested_user_id uuid,
  requested_role text,
  requested_status text
) RETURNS TABLE (
  user_id uuid,
  member_role text,
  member_status text
) LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  caller_id uuid := (SELECT auth.uid());
  previous_role text;
  previous_status text;
BEGIN
  IF caller_id IS NULL OR requested_organization_id IS DISTINCT FROM (SELECT public.current_organization_id())
    OR NOT (SELECT public.has_permission('member.manage')) THEN
    RAISE EXCEPTION 'Membership management is not permitted' USING ERRCODE = '42501';
  END IF;
  IF requested_role IS NULL OR requested_role NOT IN ('admin', 'operator', 'finance')
    OR requested_status IS NULL OR requested_status NOT IN ('active', 'disabled') THEN
    RAISE EXCEPTION 'Invalid member update' USING ERRCODE = '22023';
  END IF;
  PERFORM organization.id FROM public.organizations AS organization
  WHERE organization.id = requested_organization_id FOR UPDATE;
  SELECT role, status INTO previous_role, previous_status FROM public.organization_members
  WHERE organization_id = requested_organization_id AND organization_members.user_id = requested_user_id
  FOR UPDATE;
  IF previous_role IS NULL THEN
    RAISE EXCEPTION 'Member not found' USING ERRCODE = 'P0002';
  END IF;
  IF previous_role = 'admin' AND previous_status = 'active'
    AND (requested_role <> 'admin' OR requested_status <> 'active')
    AND (SELECT count(*) FROM public.organization_members AS member
      WHERE member.organization_id = requested_organization_id AND member.role = 'admin' AND member.status = 'active') <= 1 THEN
    RAISE EXCEPTION 'Organization must retain an active admin' USING ERRCODE = '23514';
  END IF;
  UPDATE public.organization_members AS member
  SET role = requested_role, status = requested_status
  WHERE member.organization_id = requested_organization_id AND member.user_id = requested_user_id;
  INSERT INTO public.audit_events (organization_id, actor_id, action, entity_type, entity_id, metadata)
  SELECT requested_organization_id, caller_id,
    CASE WHEN previous_role <> requested_role THEN 'member.role_changed' ELSE 'member.status_changed' END,
    'organization_member', member.id,
    jsonb_build_object('role', requested_role, 'status', requested_status)
  FROM public.organization_members AS member
  WHERE member.organization_id = requested_organization_id AND member.user_id = requested_user_id;
  RETURN QUERY SELECT requested_user_id, requested_role, requested_status;
END;
$$;


REVOKE ALL ON FUNCTION public.get_current_auth_context (uuid),
public.create_organization_invitation (uuid, text, text),
public.accept_organization_invitation (uuid),
public.update_organization_member (uuid, uuid, text, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON FUNCTION public.get_current_auth_context (uuid),
public.create_organization_invitation (uuid, text, text),
public.accept_organization_invitation (uuid),
public.update_organization_member (uuid, uuid, text, text) TO authenticated,
service_role;


REVOKE ALL ON FUNCTION public.current_data_scope ()
FROM
  public,
  anon;


GRANT
EXECUTE ON FUNCTION public.current_data_scope () TO authenticated,
service_role;


REVOKE
UPDATE ON public.organization_members
FROM
  authenticated;


REVOKE
UPDATE (organization_id) ON public.organization_members
FROM
  authenticated;