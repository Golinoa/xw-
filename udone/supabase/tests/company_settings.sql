-- C12 公司配置：版本化写入、审计、租户隔离。
--
-- 最关键的一条：旧版本写入必须被拒，且拒绝后库里的版本和数据都不能变。
-- 只断「返回了 VERSION_CONFLICT」不够——如果函数先写了再报错，前端刷新会看到
-- 一个谁都没确认过的新配置。
BEGIN;


SELECT
  plan (10);


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
    'f1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'settings-operator@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'f1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'settings-admin@example.test',
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
    'f2000000-0000-4000-8000-000000000001',
    'settings org',
    'f1000000-0000-4000-8000-000000000002'
  ),
  (
    'f2000000-0000-4000-8000-000000000002',
    'other org',
    'f1000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'f2000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'f2000000-0000-4000-8000-000000000001',
    'f1000000-0000-4000-8000-000000000002',
    'admin'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"f2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    public.get_company_settings () ->> 'version',
    '0',
    'a fresh organization reports version zero'
  );


SELECT
  ok (
    (
      SELECT
        error_code
      FROM
        public.update_company_settings ('{"theme":"dark","fontSize":"large"}'::jsonb, 0)
    ) IS NULL,
    'an admin saves the first version'
  );


SELECT
  IS (
    (
      SELECT
        data
      FROM
        public.company_settings
      WHERE
        organization_id = 'f2000000-0000-4000-8000-000000000001'
    ),
    '{"theme":"dark","fontSize":"large"}'::jsonb,
    'the saved data is the exact submitted object'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_company_settings ('{"theme":"light"}'::jsonb, 0)
    ),
    'VERSION_CONFLICT',
    'a stale version is rejected'
  );


SELECT
  IS (
    (
      SELECT
        version
      FROM
        public.company_settings
      WHERE
        organization_id = 'f2000000-0000-4000-8000-000000000001'
    ),
    1,
    'a rejected write does not advance the version'
  );


SELECT
  IS (
    (
      SELECT
        data
      FROM
        public.company_settings
      WHERE
        organization_id = 'f2000000-0000-4000-8000-000000000001'
    ),
    '{"theme":"dark","fontSize":"large"}'::jsonb,
    'a rejected write does not change the data'
  );


SELECT
  IS (
    (
      SELECT
        metadata -> 'changedKeys'
      FROM
        public.audit_events
      WHERE
        action = 'company_settings.update'
      ORDER BY
        created_at DESC
      LIMIT
        1
    ),
    '["fontSize","theme"]'::jsonb,
    'the audit records which keys changed, not the whole configuration'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.update_company_settings ('[]'::jsonb, 1)
    ),
    'INVALID_DATA',
    'a non-object payload is rejected before any write'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"f1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $$SELECT public.update_company_settings ('{"theme":"light"}'::jsonb, 1)$$,
    '42501',
    NULL,
    'an operator cannot change company settings'
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"f2000000-0000-4000-8000-000000000002"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.company_settings
    ),
    0,
    'another tenant cannot see this configuration'
  );


ROLLBACK;