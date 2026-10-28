BEGIN;


SELECT
  plan (6);


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
    '20000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'context-user@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'context-peer@example.test',
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
    '30000000-0000-4000-8000-000000000001',
    'Context Org One',
    '20000000-0000-4000-8000-000000000001'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    'Context Org Two',
    '20000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000001',
    'operator'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"20000000-0000-4000-8000-000000000001","role":"authenticated","organization_id":"30000000-0000-4000-8000-000000000001"}',
    TRUE
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
    'users can list their own memberships without a selected organization'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organizations
    ),
    2,
    'users can read the names of organizations where they hold memberships'
  );


SELECT
  lives_ok (
    $$ select * from public.create_organization_with_owner('Atomic Org') $$,
    'organization and owner membership are created through the transactional RPC'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_members
      WHERE
        user_id = auth.uid ()
        AND role = 'admin'
    ),
    2,
    'the RPC creates the authenticated user as initial admin'
  );


SELECT
  set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'sub',
      '20000000-0000-4000-8000-000000000001',
      'role',
      'authenticated',
      'organization_id',
      (
        SELECT
          organization_id::text
        FROM
          public.organization_members
        WHERE
          user_id = auth.uid ()
          AND organization_id NOT IN (
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002'
          )
        LIMIT
          1
      )
    )::text,
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    jsonb_build_object(
      'x-organization-id',
      (
        SELECT
          organization_id::text
        FROM
          public.organization_members
        WHERE
          user_id = auth.uid ()
          AND organization_id NOT IN (
            '30000000-0000-4000-8000-000000000001',
            '30000000-0000-4000-8000-000000000002'
          )
        LIMIT
          1
      )
    )::text,
    TRUE
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
    'the RPC-created organization is visible only after selecting its request context'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.organization_members
      WHERE
        organization_id = public.current_organization_id ()
    ),
    1,
    'the new organization contains only its owner membership'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;