-- 应收/应付明细的数据范围（R-FIN-01 与 SECURITY.md 数据范围）。
--
-- 回归测试：明细表的读策略最初只校验了「同组织 + order.read」，没有校验 own/all。
-- 结果是 scope=own 的操作员看不到别人的订单，却能直接读到那些订单的金额。
-- 现在策略顺着父订单判定，这个文件就是防止它被改回去。
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
    'e1000000-0000-4000-8000-000000000001',
    'authenticated',
    'authenticated',
    'finance-admin@example.test',
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
    'finance-operator@example.test',
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
    'finance-viewer@example.test',
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
    'finance org',
    'e1000000-0000-4000-8000-000000000001'
  );


INSERT INTO
  public.organization_members (organization_id, user_id, role)
VALUES
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001',
    'admin'
  ),
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000002',
    'operator'
  ),
  (
    'e2000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000003',
    'finance'
  );


INSERT INTO
  public.customers (id, organization_id, name, phone, created_by)
VALUES
  (
    'e3000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '管理员的客户',
    '13700000001',
    'e1000000-0000-4000-8000-000000000001'
  ),
  (
    'e3000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    '操作员的客户',
    '13700000002',
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
    'e7000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    '地接社',
    'transport',
    'per_trip',
    TRUE
  );


INSERT INTO
  public.orders (
    id,
    organization_id,
    order_number,
    order_type,
    status,
    customer_id,
    created_by
  )
VALUES
  (
    'e4000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    'SO-20261101-000001',
    'active',
    'active',
    'e3000000-0000-4000-8000-000000000001',
    'e1000000-0000-4000-8000-000000000001'
  ),
  (
    'e4000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    'SO-20261101-000002',
    'active',
    'active',
    'e3000000-0000-4000-8000-000000000002',
    'e1000000-0000-4000-8000-000000000002'
  );


INSERT INTO
  public.order_receivables (id, organization_id, order_id, name, amount)
VALUES
  (
    'e5000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    'e4000000-0000-4000-8000-000000000001',
    '管理员订单团款',
    1000
  ),
  (
    'e5000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    'e4000000-0000-4000-8000-000000000002',
    '操作员订单团款',
    200
  );


INSERT INTO
  public.order_payables (
    id,
    organization_id,
    order_id,
    supplier_id,
    name,
    amount
  )
VALUES
  (
    'e6000000-0000-4000-8000-000000000001',
    'e2000000-0000-4000-8000-000000000001',
    'e4000000-0000-4000-8000-000000000001',
    'e7000000-0000-4000-8000-000000000001',
    '管理员订单地接',
    500
  ),
  (
    'e6000000-0000-4000-8000-000000000002',
    'e2000000-0000-4000-8000-000000000001',
    'e4000000-0000-4000-8000-000000000002',
    'e7000000-0000-4000-8000-000000000001',
    '操作员订单地接',
    100
  );


SET
  local role authenticated;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'request.headers',
    '{"x-organization-id":"e2000000-0000-4000-8000-000000000001"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
    ),
    1,
    'operator reads only the receivable lines of their own order'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
      WHERE
        order_id = 'e4000000-0000-4000-8000-000000000001'
    ),
    0,
    'operator cannot read receivable lines of another operator order'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_payables
      WHERE
        order_id = 'e4000000-0000-4000-8000-000000000001'
    ),
    0,
    'operator cannot read payable lines of another operator order'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_payables
      WHERE
        order_id = 'e4000000-0000-4000-8000-000000000002'
    ),
    1,
    'operator still reads the payable lines of their own order'
  );


-- 财务角色数据范围是 all，只读。
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
        count(*)::int
      FROM
        public.order_receivables
    ),
    2,
    'finance role reads every receivable line of the organization'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_payables
    ),
    2,
    'finance role reads every payable line of the organization'
  );


SELECT
  throws_like (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', '财务越权新增', 100)
    $sql$,
    '%row-level security%',
    'finance role cannot add a receivable line'
  );


-- 回到管理员核对「越权写」确实没有生效。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
    ),
    2,
    'admin reads both receivable lines'
  );


-- 换回操作员：对别人的订单行发起的写入必须落空。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000002","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_like (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000001', '越权新增', 100)
    $sql$,
    '%row-level security%',
    'operator cannot add a receivable line to another operator order'
  );


-- 明细行不支持就地改：金额列没有 UPDATE 授权，改价必须走 update_order_with_items
-- 整体重写。这条断言把这个约定固定住，避免有人为了「顺手改一行」放开列授权。
SELECT
  throws_like (
    $sql$
    UPDATE public.order_receivables SET amount = 999999 WHERE id = 'e5000000-0000-4000-8000-000000000001'
    $sql$,
    '%permission denied%',
    'receivable amounts cannot be edited in place'
  );


DELETE FROM public.order_receivables
WHERE
  id = 'e5000000-0000-4000-8000-000000000001';


SELECT
  lives_ok (
    $sql$
    INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
    VALUES ('e2000000-0000-4000-8000-000000000001', 'e4000000-0000-4000-8000-000000000002', '操作员新增', 300)
    $sql$,
    'operator can add a receivable line to their own order'
  );


SELECT
  IS (
    (
      SELECT
        count(*)::int
      FROM
        public.order_receivables
    ),
    2,
    'the line added by the operator is visible to the operator'
  );


SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        id = 'e4000000-0000-4000-8000-000000000002'
    ),
    500.00,
    'the trigger recomputes totals when an operator writes a line'
  );


-- 管理员视角：管理员订单的金额没被越权改过，那一行也没被删掉。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"e1000000-0000-4000-8000-000000000001","role":"authenticated"}',
    TRUE
  );


SELECT
  IS (
    (
      SELECT
        amount
      FROM
        public.order_receivables
      WHERE
        id = 'e5000000-0000-4000-8000-000000000001'
    ),
    1000.00,
    'an out-of-scope update and delete leave the original line untouched'
  );


-- 触发器保证合计始终由明细派生，这里顺带确认直接写明细也会更新订单合计。
SELECT
  IS (
    (
      SELECT
        receivable_total
      FROM
        public.orders
      WHERE
        id = 'e4000000-0000-4000-8000-000000000001'
    ),
    1000.00,
    'order totals stay derived from the lines after direct line writes'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;