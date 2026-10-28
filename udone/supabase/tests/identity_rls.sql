BEGIN;


SELECT
  plan (15);


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
    '00000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'owner@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'member@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '00000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'outsider@example.test',
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
    '10000000-0000-4000-8000-000000000001',
    'Test Org One',
    '00000000-0000-4000-8000-000000000001'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'Test Org Two',
    '00000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    '10000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000002',
    'admin'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000002","role":"authenticated","organization_id":"10000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"10000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    '10000000-0000-4000-8000-000000000001'::uuid,
    'member resolves the selected organization'
  );


SELECT
  ok (
    public.has_permission ('organization.read'),
    'operator has organization read permission'
  );


SELECT
  ok (
    NOT public.has_permission ('settings.manage'),
    'operator lacks settings management permission'
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
    'member can read only the selected organization'
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
    'member can read only the selected organization roster'
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
    'operator cannot read audit events'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated","organization_id":"10000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"10000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$ update public.organization_members set organization_id = '10000000-0000-4000-8000-000000000002' where user_id = '00000000-0000-4000-8000-000000000001' $$,
    '42501',
    NULL,
    'RLS prevents an admin from moving a membership to another organization'
  );


SELECT
  throws_ok (
    $$ delete from public.organization_members where organization_id = '10000000-0000-4000-8000-000000000002' $$,
    '42501',
    NULL,
    'authenticated members cannot delete organization memberships'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated","organization_id":"10000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"10000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  IS (
    public.current_organization_id (),
    NULL::uuid,
    'non-member has no selected organization context'
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
    'non-member cannot read an organization'
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
    'non-member cannot read organization memberships'
  );


SELECT
  throws_ok (
    $$ insert into public.organization_members (organization_id, user_id, role) values ('10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'admin') $$,
    '42501',
    NULL,
    'non-member cannot add itself to an existing organization'
  );


INSERT INTO
  public.organizations (id, name, created_by)
VALUES
  (
    '10000000-0000-4000-8000-000000000003',
    'Test Org Three',
    '00000000-0000-4000-8000-000000000003'
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
    'new organization is hidden until the owner selects it'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    '10000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000003',
    'admin'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-000000000003","role":"authenticated","organization_id":"10000000-0000-4000-8000-000000000003"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"10000000-0000-4000-8000-000000000003"}',
    TRUE
  );


SELECT
  IS (
    public.current_organization_id (),
    '10000000-0000-4000-8000-000000000003'::uuid,
    'creator can become initial organization admin'
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
    'initial admin can read the created organization'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;