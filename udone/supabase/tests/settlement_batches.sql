-- C6 批量结算：锁定口径、累计封顶、作废释放、以及「只能走函数写」。
--
-- 这张表最容易做错的不是 CRUD，而是三个口径：
--   1. 结算**不动** order_payables 的 pending/confirmed —— 一旦写进去，
--      同一笔钱会被算两次在途，可申请余额和报表同时偏小；
--   2. 累计已确认结算金额 ≤ 应付金额，超了必须拒，否则「重复结算」只是换个说法；
--   3. 作废已确认批次要把锁定标记清掉，额度确实回到可用，而不是只改一个状态字。
-- 另外断言 authenticated 对明细表没有写权限：能直写就等于能绕过全部校验。
BEGIN;


SELECT
  plan (22);


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
    'e1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'settle-finance@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'e1000000-0000-4000-8000-000000000002',
    'authenticated',
    'authenticated',
    'settle-admin@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'e1000000-0000-4000-8000-000000000003',
    'authenticated',
    'authenticated',
    'settle-other-org@example.test',
    '',
    now(),
    '{}',
    '{}',
    now(),
    now()
  ),
  (
    'e1000000-0000-4000-8000-000000000004',
    'authenticated',
    'authenticated',
    'settle-operator@example.test',
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
    'e2000000-0000-4000-8000-000000000001',
    '结算测试公司',
    'e1000000-0000-4000-8000-000000000002'
  ),
  (
    'e2000000-0000-4000-8000-000000000002',
    '别家结算公司',
    'e1000000-0000-4000-8000-000000000003'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'finance'
  ),
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000002',
    'admin'
  ),
  (
    'e2000000-0000-4000-8000-000000000002',
    'e1000000-0000-4000-8000-000000000003',
    'finance'
  ),
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000004',
    'operator'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'e3000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '结算测试客户',
    '13900000071',
    'e1000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.suppliers (
    id,
    organization_id,
    name,
    type,
    settlement,
    is_active
  )
VALUES
  (
    'e4000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '结算地接社',
    'transport',
    'monthly',
    TRUE
  ),
  (
    'e4000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    '结算票务',
    'ticket',
    'monthly',
    TRUE
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"e2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


-- 建单要 order.write，财务没有；用管理员建夹具，之后再用财务身份验结算。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.order',
    (
      SELECT
        public.create_order_with_items (
          'e3000000-0000-4000-8000-000000000001',
          'booking',
          '[{"name":"团款","amount":9000}]'::jsonb,
          '[{"name":"地接","amount":4000,"supplierId":"e4000000-0000-4000-8000-000000000001"},{"name":"门票","amount":1000,"supplierId":"e4000000-0000-4000-8000-000000000002"}]'::jsonb,
          '结算测试线路',
          '2027-02-01',
          '2027-02-06',
          2,
          0
        )::text
    ),
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'test.pay.main',
    (
      SELECT
        id::text
      FROM
        public.order_payables
      WHERE
        order_id = current_setting('test.order')::uuid
        AND name = '地接'
    ),
    TRUE
  );


SELECT
  set_config(
    'test.pay.ticket',
    (
      SELECT
        id::text
      FROM
        public.order_payables
      WHERE
        order_id = current_setting('test.order')::uuid
        AND name = '门票'
    ),
    TRUE
  );


-- 财务建草稿批次：整批写入，返回 id 且无错误码。
SELECT
  set_config(
    'test.batch.main',
    (
      SELECT
        result_batch_id::text
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000001',
          requested_period_start => '2026-11-01'::date,
          requested_method => 'bank',
          requested_note => '11 月地接结算',
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.main'),
              'amount',
              4000
            )
          )
        )
      WHERE
        error_code IS NULL
    ),
    TRUE
  );


-- 1. 草稿的总额等于明细之和（总额是明细算出来的，不是另一处手填的）。
SELECT
  IS (
    (
      SELECT
        total_amount
      FROM
        public.settlement_batches
      WHERE
        id = current_setting('test.batch.main')::uuid
    ),
    4000.00,
    'a draft batch totals its items'
  );


-- 2. 明细保存了应付行名称快照：应付行被改写后，凭证仍读得懂。
SELECT
  IS (
    (
      SELECT
        payable_name
      FROM
        public.settlement_items
      WHERE
        batch_id = current_setting('test.batch.main')::uuid
    ),
    '地接',
    'a settlement item snapshots the payable name'
  );


-- 3. 同月同供应商再开一个批次会被拒（否则「这个月结了多少」有两个答案）。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000001',
          requested_period_start => '2026-11-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.main'),
              'amount',
              100
            )
          )
        )
    ),
    'BATCH_EXISTS',
    'a second batch for the same supplier and month is rejected'
  );


-- 4. 周期不是自然月首日 → 拒绝，不做「猜用户想结哪个月」。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000001',
          requested_period_start => '2026-11-15'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.main'),
              'amount',
              100
            )
          )
        )
    ),
    'PERIOD_INVALID',
    'a period that is not the first day of a month is rejected'
  );


-- 5. 把别家供应商的应付行塞进这批 → 拒绝（供应商不一致的结算单没法对账）。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000001',
          requested_period_start => '2026-09-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.ticket'),
              'amount',
              100
            )
          )
        )
    ),
    'SUPPLIER_MISMATCH',
    'a payable from another supplier is rejected'
  );


-- 6. 超过应付金额 1 分钱也不行。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000002',
          requested_period_start => '2026-10-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.ticket'),
              'amount',
              1000.01
            )
          )
        )
    ),
    'AMOUNT_EXCEEDS_AVAILABLE',
    'an amount above the payable total is rejected'
  );


-- 校验失败不能留下 0 金额空批次：以前先插批次再逐条校验，
-- 封顶拒绝后列表里会多出一条永远结不完的草稿。
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.settlement_batches
      WHERE
        supplier_id = 'e4000000-0000-4000-8000-000000000002'
        AND period_start = '2026-10-01'::date
    ),
    0,
    'a rejected batch leaves no orphan draft'
  );


-- 7. 确认批次。到这一步才真正锁额度。
SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.confirm_settlement_batch (current_setting('test.batch.main')::uuid)
    ),
    'confirmed',
    'a draft batch is confirmed'
  );


-- 8. 已确认的明细带上了锁定标记（累计口径靠它）。
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.settlement_items
      WHERE
        batch_id = current_setting('test.batch.main')::uuid
        AND confirmed_at IS NOT NULL
    ),
    1,
    'confirming a batch stamps every item'
  );


-- 9. 结算**没有**碰应付行的在途/已付金额：两条口径不能互相污染。
SELECT
  IS (
    (
      SELECT
        (
          pending_amount,
          confirmed_amount,
          available_amount
        )::text
      FROM
        public.order_payables
      WHERE
        id = current_setting('test.pay.main')::uuid
    ),
    '(0.00,0.00,4000.00)',
    'settlement does not touch the payable money columns'
  );


-- 10. 已被全额结算的明细，下个月再结一次必须被拒（这就是「不得重复结算」）。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000001',
          requested_period_start => '2026-12-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.main'),
              'amount',
              4000
            )
          )
        )
    ),
    'AMOUNT_EXCEEDS_AVAILABLE',
    'a fully settled payable cannot be settled again'
  );


-- 11. 部分结算是允许的：门票 1000 先结 600。
SELECT
  set_config(
    'test.batch.ticket',
    (
      SELECT
        result_batch_id::text
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000002',
          requested_period_start => '2026-11-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.ticket'),
              'amount',
              600
            )
          )
        )
      WHERE
        error_code IS NULL
    ),
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.confirm_settlement_batch (current_setting('test.batch.ticket')::uuid)
    ),
    'confirmed',
    'a partial settlement can be confirmed'
  );


-- 12. 尾款 400 在下个月还能结（累计 600 + 400 = 1000，不超过应付）。
SELECT
  set_config(
    'test.batch.ticket.rest',
    (
      SELECT
        result_batch_id::text
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000002',
          requested_period_start => '2026-12-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.ticket'),
              'amount',
              400
            )
          )
        )
      WHERE
        error_code IS NULL
    ),
    TRUE
  );


-- 13. 重复确认同一个批次 → 拒绝（不是幂等成功，也不是再锁一次）。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.confirm_settlement_batch (current_setting('test.batch.ticket')::uuid)
    ),
    'STATE_CONFLICT',
    'confirming an already confirmed batch is rejected'
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.confirm_settlement_batch (current_setting('test.batch.ticket.rest')::uuid)
    ),
    'confirmed',
    'the remaining amount can be settled next month'
  );


-- 14. 累计封顶：门票已结满 1000，再结 1 分钱也不行。
SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000002',
          requested_period_start => '2027-01-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.ticket'),
              'amount',
              0.01
            )
          )
        )
    ),
    'AMOUNT_EXCEEDS_AVAILABLE',
    'the cumulative cap rejects one cent above the payable total'
  );


-- 15. 计调员只有 finance.write、没有 finance.approve：作废「已确认」批次被拒
--     （42501，不是静默成功）。财务与管理员都持有 finance.approve，可以作废。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000004","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    $sql$
    SELECT public.cancel_settlement_batch (
      current_setting('test.batch.main')::uuid, '结错了'
    )
    $sql$,
    '42501',
    NULL,
    'an operator without finance.approve cannot cancel a confirmed batch'
  );


-- 16. 有审批权的人可以作废，并且必须写原因。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.cancel_settlement_batch (current_setting('test.batch.main')::uuid, NULL)
    ),
    'REASON_REQUIRED',
    'cancelling a confirmed batch requires a reason'
  );


SELECT
  IS (
    (
      SELECT
        new_status
      FROM
        public.cancel_settlement_batch (current_setting('test.batch.main')::uuid, '结错了')
    ),
    'cancelled',
    'an administrator cancels a confirmed batch'
  );


-- 17. 作废释放额度：锁定标记清空，地接那 4000 可以重新结算。
SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.settlement_items
      WHERE
        batch_id = current_setting('test.batch.main')::uuid
        AND confirmed_at IS NOT NULL
    ),
    0,
    'cancelling a batch releases its items'
  );


SELECT
  IS (
    (
      SELECT
        error_code
      FROM
        public.create_settlement_batch (
          requested_supplier_id => 'e4000000-0000-4000-8000-000000000001',
          requested_period_start => '2027-01-01'::date,
          requested_method => 'bank',
          requested_note => NULL,
          requested_items => jsonb_build_array(
            jsonb_build_object(
              'payableId',
              current_setting('test.pay.main'),
              'amount',
              4000
            )
          )
        )
    ),
    NULL,
    'a released payable can be settled again'
  );


-- 18. 跨组织读不到（RLS 按 current_organization_id 过滤，不是靠应用层过滤）。
SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"e2000000-0000-4000-8000-000000000002"}',
    TRUE
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000003","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        pg_catalog.count (*)::integer
      FROM
        public.settlement_batches
    ),
    0,
    'another organization cannot read these batches'
  );


-- 19. 客户端对明细表没有写权限：能直写就等于能绕过全部校验。
SELECT
  throws_ok (
    $sql$
    INSERT INTO public.settlement_items (
      organization_id, batch_id, order_id, payable_id, order_number, payable_name, amount
    ) VALUES (
      'e2000000-0000-4000-8000-000000000002',
      'e5000000-0000-4000-8000-000000000001',
      current_setting('test.order')::uuid,
      current_setting('test.pay.ticket')::uuid,
      'X', '手写明细', 1
    )
    $sql$,
    '42501',
    NULL,
    'authenticated cannot write settlement items directly'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;