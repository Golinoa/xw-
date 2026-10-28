CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE public.organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('admin', 'operator', 'finance')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);


CREATE TABLE public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);


CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  entity_type text,
  entity_id uuid,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX organization_members_user_id_idx ON public.organization_members (user_id);


CREATE INDEX audit_events_organization_created_at_idx ON public.audit_events (organization_id, created_at DESC);


ALTER TABLE public.organizations enable ROW level security;


ALTER TABLE public.organization_members enable ROW level security;


ALTER TABLE public.profiles enable ROW level security;


ALTER TABLE public.audit_events enable ROW level security;


-- Remove Supabase default grants first; restore only explicitly allowed operations.
REVOKE ALL ON public.organizations,
public.organization_members,
public.profiles,
public.audit_events
FROM
  public,
  anon,
  authenticated;


GRANT
SELECT
,
  insert,
UPDATE ON public.organizations TO authenticated;


GRANT
SELECT
  ON public.organization_members TO authenticated;


GRANT
UPDATE (organization_id) ON public.organization_members TO authenticated;


GRANT
SELECT
,
  insert,
UPDATE ON public.profiles TO authenticated;


GRANT
SELECT
  ON public.audit_events TO authenticated;


GRANT ALL ON public.organizations,
public.organization_members,
public.profiles,
public.audit_events TO service_role;