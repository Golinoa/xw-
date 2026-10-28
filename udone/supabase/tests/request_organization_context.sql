BEGIN;


SELECT
  plan (14);


INSERT INTO
  auth.users (
    id,
    aud,
    role,
    email,
    encrypted_password,
    email_confirmed_at,
    raw_app_meta_data,
    raw_user_meta_data,
    created_at,
    updated_at
  )
VALUES
  (
    '40000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'context-admin@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '40000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'context-member@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '40000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'context-outsider@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  );


INSERT INTO
  public.organizations (id, name, created_by)
VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    'Request Org One',
    '40000000-0000-4000-8000-000000000001'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    'Request Org Two',
    '40000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    '50000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    '50000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    '50000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',
    'finance'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated","organization_id":"50000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"50000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    '50000000-0000-4000-8000-000000000001'::uuid,
    'usesSelectedOrganizationFromRequestHeader'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organizations
    ),
    1,
    'request header scopes organization reads'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_members
    ),
    2,
    'request header scopes roster reads'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.audit_events
    ),
    0,
    'member without audit permission cannot read audit events'
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"50000000-0000-4000-8000-000000000002"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    '50000000-0000-4000-8000-000000000002'::uuid,
    'member can switch to another organization they belong to'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organizations
    ),
    1,
    'selected second organization is readable'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_members
    ),
    1,
    'selected second organization roster is isolated'
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"50000000-0000-4000-8000-000000000003"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    NULL::uuid,
    'deniesNonMemberOrganizationHeader'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organizations
    ),
    0,
    'nonmember header cannot read organizations'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_members
    ),
    0,
    'nonmember header cannot read memberships'
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"not-a-uuid"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    NULL::uuid,
    'malformed organization header returns null'
  );


SELECT
  set_config('request.headers', '{}', TRUE);


SELECT
  IS (
    public.current_organization_id (),
    NULL::uuid,
    'failsClosedWithoutOrganizationHeader'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"40000000-0000-4000-8000-000000000001","role":"authenticated","organization_id":"50000000-0000-4000-8000-000000000002"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"50000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    '50000000-0000-4000-8000-000000000001'::uuid,
    'untrusted JWT organization claim cannot override request context'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"40000000-0000-4000-8000-000000000003","role":"authenticated","organization_id":"50000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    NULL::uuid,
    'forged user identity cannot obtain organization context'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;