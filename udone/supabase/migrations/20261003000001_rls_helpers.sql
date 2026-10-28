CREATE OR REPLACE FUNCTION public.current_organization_id () returns uuid language sql stable security definer
SET
  search_path = '' AS $$
  select member.organization_id
  from public.organization_members as member
  where member.user_id = (select auth.uid())
    and member.organization_id = nullif(auth.jwt() ->> 'organization_id', '')::uuid
  limit 1;
$$;


CREATE OR REPLACE FUNCTION public.is_organization_creator (target_organization_id uuid) returns boolean language sql stable security definer
SET
  search_path = '' AS $$
  select exists (
    select 1 from public.organizations as organization
    where organization.id = target_organization_id
      and organization.created_by = (select auth.uid())
  );
$$;


CREATE OR REPLACE FUNCTION public.has_permission (permission text) returns boolean language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(bool_or(
    case member.role
      when 'admin' then permission in ('organization.read', 'member.manage', 'settings.manage', 'audit.read')
      when 'operator' then permission = 'organization.read'
      when 'finance' then permission in ('organization.read', 'audit.read')
      else false
    end
  ), false)
  from public.organization_members as member
  where member.user_id = (select auth.uid())
    and member.organization_id = (select public.current_organization_id());
$$;


REVOKE ALL ON function public.current_organization_id ()
FROM
  public,
  anon;


REVOKE ALL ON function public.has_permission (text)
FROM
  public,
  anon;


REVOKE ALL ON function public.is_organization_creator (uuid)
FROM
  public,
  anon;


GRANT
EXECUTE ON function public.current_organization_id () TO authenticated,
service_role;


GRANT
EXECUTE ON function public.has_permission (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function public.is_organization_creator (uuid) TO authenticated,
service_role;


-- Organization creation can atomically add only the creator as its initial admin.
GRANT insert (organization_id, user_id, role) ON public.organization_members TO authenticated;


CREATE POLICY organization_members_insert_initial_admin ON public.organization_members FOR insert TO authenticated
WITH
  CHECK (
    public.is_organization_creator (organization_id)
    AND user_id = (
      SELECT
        auth.uid ()
    )
    AND role = 'admin'
  );


CREATE POLICY organizations_select_member ON public.organizations FOR
SELECT
  TO authenticated USING (
    id = (
      SELECT
        public.current_organization_id ()
    )
  );


CREATE POLICY organizations_insert_creator ON public.organizations FOR insert TO authenticated
WITH
  CHECK (
    created_by = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY organizations_update_admin ON public.organizations
FOR UPDATE
  TO authenticated USING (
    id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('settings.manage')
    )
  )
WITH
  CHECK (
    id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('settings.manage')
    )
  );


CREATE POLICY organization_members_select_current_org ON public.organization_members FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


CREATE POLICY organization_members_update_current_admin ON public.organization_members
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('member.manage')
    )
  )
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('member.manage')
    )
  );


CREATE POLICY profiles_select_self ON public.profiles FOR
SELECT
  TO authenticated USING (
    id = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY profiles_insert_self ON public.profiles FOR insert TO authenticated
WITH
  CHECK (
    id = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY profiles_update_self ON public.profiles
FOR UPDATE
  TO authenticated USING (
    id = (
      SELECT
        auth.uid ()
    )
  )
WITH
  CHECK (
    id = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY audit_events_select_audit_permission ON public.audit_events FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('audit.read')
    )
  );