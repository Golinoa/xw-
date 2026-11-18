-- C11 CRM 线索：阶段/跟进事件、公海认领、超时回收、幂等转客户。
--
-- 最关键的一条：同一个线索调两次 convert_lead_to_customer 必须返回同一个客户 id。
-- 只断「转换后有一个客户」不够——如果第二次又建一个，重复客户就产生了。
BEGIN;


SELECT
  plan (8);


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
    'd8000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'crm-owner@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'd8000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'crm-admin@example.test',
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
    'd9000000-0000-4000-8000-000000000001',
    'crm org',
    'd8000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'd9000000-0000-4000-8000-000000000001',
    'd8000000-0000-4000-8000-000000000001',
    'operator'
  ),
  (
    'd9000000-0000-4000-8000-000000000001',
    'd8000000-0000-4000-8000-000000000002',
    'admin'
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"d9000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"d8000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_lead (
          '线索测试客户',
          '13800000131',
          NULL,
          NULL,
          '官网',
          '云南',
          '深圳',
          '跟团游',
          '高',
          '2026-12-20',
          3000,
          8000,
          2,
          0,
          '复刻调研测试线索'
        )
    ),
    NULL,
    'an operator creates a lead with the required fields'
  );


SELECT
  set_config(
    'test.lead',
    (
      SELECT
        id::text
      FROM
        public.leads
      WHERE
        organization_id = 'd9000000-0000-4000-8000-000000000001'
      LIMIT
        1
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        count(*)::integer
      FROM
        public.lead_events
      WHERE
        lead_id = current_setting('test.lead')::uuid
    ),
    1,
    'creating a lead appends one timeline event'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.record_lead_follow_up (
          current_setting('test.lead')::uuid,
          'quoting',
          '已发报价',
          NULL
        )
    ),
    NULL,
    'the owner records a follow-up and advances the stage'
  );


SELECT
  IS (
    (
      SELECT
        stage::text
      FROM
        public.leads
      WHERE
        id = current_setting('test.lead')::uuid
    ),
    'quoting',
    'the stage is updated'
  );


-- 超时回收：造一条 8 天前的线索并回收。
-- leads 表没有给 authenticated 直接 UPDATE 的策略（所有写走 RPC），
-- 所以这里临时提权造数据，测的仍是回收函数本身。
SET
  local role postgres;


UPDATE public.leads
SET
  created_at = pg_catalog.now () - interval '8 days',
  last_follow_up_at = NULL
WHERE
  id = current_setting('test.lead')::uuid;


SET
  local role authenticated;


SELECT
  IS (
    (
      SELECT
        recycled_count
      FROM
        public.recycle_stale_leads (pg_catalog.now ())
    ),
    1,
    'a lead with no follow-up for 7 days is recycled to the pool'
  );


SELECT
  IS (
    (
      SELECT
        owner_id
      FROM
        public.leads
      WHERE
        id = current_setting('test.lead')::uuid
    ),
    NULL,
    'a recycled lead has no owner'
  );


-- 阶段设为 won 后转客户，验证幂等。回收后线索在公海，先认领回来。
SELECT
  error_code
FROM
  public.claim_lead (
    current_setting('test.lead')::uuid,
    (
      SELECT
        version
      FROM
        public.leads
      WHERE
        id = current_setting('test.lead')::uuid
    )
  );


SELECT
  public.record_lead_follow_up (
    current_setting('test.lead')::uuid,
    'won',
    '已成单',
    NULL
  );


SELECT
  set_config(
    'test.customer',
    (
      SELECT
        result_customer_id::text
      FROM
        public.convert_lead_to_customer (current_setting('test.lead')::uuid)
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        result_customer_id::text
      FROM
        public.convert_lead_to_customer (current_setting('test.lead')::uuid)
    ),
    current_setting('test.customer'),
    'converting twice returns the same customer id'
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.customers
      WHERE
        organization_id = 'd9000000-0000-4000-8000-000000000001'
    ),
    1,
    'idempotent conversion creates exactly one customer'
  );


ROLLBACK;