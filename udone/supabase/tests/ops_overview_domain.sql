BEGIN;


SELECT
  plan (39);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 三个身份，选的是**互补**的两个权限集，不是「强 / 弱」：
--
--   delivery_ops：customer / contract / entitlement / tenant / ticket 都有，
--                 唯独没有 `receivable.read`
--   finance_ops ：receivable 有，tenant 与 ticket 都没有
--
-- 这正是 `/overview` 的难点所在：一张总览里有七个指标分属五种权限，谁都看不全。
-- 只测「有权限的人看得到」不会发现 `restrictedMetrics[]` 有没有把无权指标挡掉
-- ——那个缺陷的形状是「显示 0」，而不是报错。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000009b1',
    'authenticated',
    'authenticated',
    'overview-delivery@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000009b2',
    'authenticated',
    'authenticated',
    'overview-finance@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000009b3',
    'authenticated',
    'authenticated',
    'overview-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000009a1',
    '00000000-0000-4000-8000-0000000009b1',
    'overview-delivery@example.test',
    'overview 交付',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a2',
    '00000000-0000-4000-8000-0000000009b2',
    'overview-finance@example.test',
    'overview 财务',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a3',
    '00000000-0000-4000-8000-0000000009b3',
    'overview-norole@example.test',
    'overview 无角色',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  fixture.operator_id,
  role.id,
  fixture.operator_id
FROM
  (
    VALUES
      (
        '00000000-0000-4000-8000-0000000009a1'::uuid,
        'delivery_ops'
      ),
      (
        '00000000-0000-4000-8000-0000000009a2'::uuid,
        'finance_ops'
      )
  ) AS fixture (operator_id, role_code)
  JOIN ops.roles AS role ON role.code = fixture.role_code;


-- 三个客户：甲签了合同（计入有效软件客户）、乙只有草稿合同（不计）、丙是
-- 未签约的 onboarding 客户且什么都没有（不计）。
-- 客户状态只有五种，没有「潜在客户」：onboarding 才是那个还没签的档。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000009c1',
    'overview 客户甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009c2',
    'overview 客户乙',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009c3',
    'overview 客户丙',
    'onboarding'
  );


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000009e1',
    'PRD-OVW',
    'overview 测试产品',
    'active'
  );


INSERT INTO
  ops.packages (
    id,
    product_id,
    internal_name,
    customer_name,
    sales_mode,
    billing_type,
    list_price,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009e2',
    '00000000-0000-4000-8000-0000000009e1',
    '标准版',
    '标准版',
    'saas',
    'periodic',
    1000.00,
    'active'
  );


INSERT INTO
  ops.contracts (
    id,
    customer_id,
    sales_mode,
    status,
    total_amount,
    currency,
    effective_on
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009c1',
    'saas',
    'signed',
    1900.00,
    'CNY',
    DATE '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000009d2',
    '00000000-0000-4000-8000-0000000009c2',
    'saas',
    'draft',
    1000.00,
    'CNY',
    DATE '2026-01-01'
  );


INSERT INTO
  ops.contract_items (
    id,
    contract_id,
    product_id,
    package_id,
    sales_mode,
    billing_type,
    quantity,
    unit_price,
    amount,
    item_name_snapshot,
    line_no
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009d3',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009e2',
    'saas',
    'periodic',
    1,
    1900.00,
    1900.00,
    '标准版',
    1
  ),
  (
    '00000000-0000-4000-8000-0000000009d4',
    '00000000-0000-4000-8000-0000000009d2',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009e2',
    'saas',
    'periodic',
    1,
    1000.00,
    1000.00,
    '标准版',
    1
  ),
  -- 同一份合同上第二条条目：`subscriptions_open_item_key` 让「一条目一份
  -- 未结束订阅」成立，所以第二份订阅必须挂在第二个条目上。金额取 0 是为了
  -- 不打乱上面三期应收与合同总额的对应关系。
  (
    '00000000-0000-4000-8000-0000000009d5',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009e2',
    'saas',
    'periodic',
    1,
    0.00,
    0.00,
    '标准版（第二条目）',
    2
  );


-- 三期应收：逾期未收 1000、部分收款未到期 500（已收 200）、未到期未收 400。
-- 三者合起来让「total = settled + overdue + upcoming」这条恒等式可断言。
INSERT INTO
  ops.receivables (
    id,
    contract_id,
    customer_id,
    period_no,
    due_date,
    amount,
    currency,
    allocated_amount,
    reversed_amount
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f1',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009c1',
    1,
    ops.receivable_today () - 5,
    1000.00,
    'CNY',
    0,
    0
  ),
  (
    '00000000-0000-4000-8000-0000000009f2',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009c1',
    2,
    ops.receivable_today () + 20,
    500.00,
    'CNY',
    200.00,
    0
  ),
  (
    '00000000-0000-4000-8000-0000000009f3',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009c1',
    3,
    ops.receivable_today () + 20,
    400.00,
    'CNY',
    0,
    0
  );


-- 两笔收款：一笔已登记待审核（recorded 100）、一笔已审核待核销
-- （pending_reconcile 50）。两个 metric 各取一种状态，否则两个字段互换也测不出来。
INSERT INTO
  ops.receipts (
    id,
    customer_id,
    contract_id,
    transaction_date,
    amount,
    currency,
    method_code,
    status,
    recorded_by,
    recorded_reason
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f4',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009d1',
    ops.receivable_today (),
    100.00,
    'CNY',
    'bank',
    'recorded',
    '00000000-0000-4000-8000-0000000009a2',
    '总览测试'
  ),
  (
    '00000000-0000-4000-8000-0000000009f5',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009d1',
    ops.receivable_today (),
    50.00,
    'CNY',
    'bank',
    'pending_reconcile',
    '00000000-0000-4000-8000-0000000009a2',
    '总览测试'
  );


-- 权益：两份订阅（10 天后到期 / 100 天后到期）+ 一份 5 天后到期的授权。
-- 三个到期日让「窗口天数真的被用上」可断言：30 天窗口数到 2、4 天数到 0、
-- 6 天数到 1。写死 30 的实现会在后两条上露出原形。
INSERT INTO
  ops.subscriptions (
    id,
    customer_id,
    contract_id,
    contract_item_id,
    product_id,
    package_id,
    billing_cycle,
    starts_on,
    ends_on,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009a4',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009d3',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009e2',
    'yearly',
    ops.receivable_today () - 355,
    ops.receivable_today () + 10,
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009a5',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009d5',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009e2',
    'yearly',
    ops.receivable_today () - 265,
    ops.receivable_today () + 100,
    'active'
  );


INSERT INTO
  ops.private_licenses (
    id,
    customer_id,
    contract_id,
    contract_item_id,
    license_mode,
    valid_from,
    valid_to,
    status
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009a6',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009d3',
    'term',
    ops.receivable_today () - 30,
    ops.receivable_today () + 5,
    'active'
  );


-- 工单：两张未结束（其中一张在等待）、一张已关闭。
-- 「未结束」按 `NOT IN resolved/closed` 算，不是「不等于 closed」——resolved
-- 的活儿干完了，留在「开放」里会让这个数字永远降不下去。
INSERT INTO
  ops.tickets (
    id,
    customer_id,
    subject,
    description,
    issue_type,
    priority,
    status,
    waiting_on,
    closed_at
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009a7',
    '00000000-0000-4000-8000-0000000009c1',
    '总览测试工单甲',
    '描述',
    'bug',
    'high',
    'new',
    NULL,
    NULL
  ),
  (
    '00000000-0000-4000-8000-0000000009a8',
    '00000000-0000-4000-8000-0000000009c1',
    '总览测试工单乙',
    '描述',
    'howto',
    'normal',
    'waiting',
    '客户反馈',
    NULL
  ),
  (
    '00000000-0000-4000-8000-0000000009a9',
    '00000000-0000-4000-8000-0000000009c1',
    '总览测试工单丙',
    '描述',
    'bug',
    'low',
    'closed',
    NULL,
    now()
  );


-- 租户映射：三行分别验三件事——
--   甲 映射：active + 远端 active + 有 org id  → 计 1 个运行中租户，最新命令 succeeded
--   乙 映射：同样 active 但 org id 为 NULL     → 不计（开通还没回来）
--   丙 映射：pending，最新命令 failed          → 计 1 个同步失败
INSERT INTO
  ops.tenant_mappings (
    id,
    customer_id,
    product_id,
    udone_organization_id,
    mapping_status,
    last_known_state
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009b4',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009e1',
    '00000000-0000-4000-8000-0000000009f9',
    'active',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009b5',
    '00000000-0000-4000-8000-0000000009c2',
    '00000000-0000-4000-8000-0000000009e1',
    NULL,
    'active',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000009b6',
    '00000000-0000-4000-8000-0000000009c3',
    '00000000-0000-4000-8000-0000000009e1',
    NULL,
    'pending',
    NULL
  );


INSERT INTO
  ops.tenant_commands (
    id,
    idempotency_key,
    mapping_id,
    command_type,
    reason,
    status,
    attempt_count,
    completed_at
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009c4',
    'overview-success',
    '00000000-0000-4000-8000-0000000009b4',
    'activate',
    '总览测试',
    'succeeded',
    1,
    now()
  ),
  (
    '00000000-0000-4000-8000-0000000009c5',
    'overview-failed',
    '00000000-0000-4000-8000-0000000009b6',
    'provision',
    '总览测试',
    'failed',
    2,
    now()
  );


-- ── 切到交付运营身份 ────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── A：形状与无权指标 ───────────────────────────────────────────────────────
-- 交付运营没有 `receivable.read`：金额区必须整块缺席，而不是回 0。
SELECT
  set_config(
    'ovw.delivery',
    ops.get_ops_overview ()::text,
    TRUE
  );


SELECT
  IS (
    current_setting('ovw.delivery')::jsonb #>> '{status}',
    'ok',
    'A1 delivery_ops can read the overview'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{window_days}'
    )::integer,
    30,
    'A2 windowDays falls back to settings.overview.expiryWindowDays'
  );


SELECT
  ok (
    current_setting('ovw.delivery')::jsonb #>> '{statistics_at}' IS NOT NULL,
    'A3 statisticsAt is always present'
  );


SELECT
  ok (
    NOT (
      current_setting('ovw.delivery')::jsonb #> '{metrics}'
    ) ? 'pending_receipt_amount',
    'A4 a metric the caller cannot read is absent, not zero'
  );


SELECT
  ok (
    (
      current_setting('ovw.delivery')::jsonb #> '{restricted_metrics}'
    ) ? 'amounts',
    'A5 restricted metrics name the hidden section'
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('ovw.delivery')::jsonb #> '{restricted_metrics}'
    ),
    3,
    'A6 exactly the three receivable metrics are restricted'
  );


SELECT
  IS (
    current_setting('ovw.delivery')::jsonb #> '{amounts}',
    '[]'::jsonb,
    'A7 amounts is an empty array rather than an empty object'
  );


-- ── B：七个指标的口径 ───────────────────────────────────────────────────────
SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,active_customers}'
    )::integer,
    1,
    'B1 active customers require an active customer with a signed contract'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,active_contracts}'
    )::integer,
    1,
    'B2 a draft contract is not an active contract'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,running_tenants}'
    )::integer,
    1,
    'B3 a mapping without an organisation id is not a running tenant'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,active_entitlements}'
    )::integer,
    3,
    'B4 active entitlements count subscriptions and licences together'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,expiring_entitlements}'
    )::integer,
    2,
    'B5 a 30 day window catches the 10 day subscription and the 5 day licence'
  );


SELECT
  set_config(
    'ovw.narrow',
    ops.get_ops_overview (4)::text,
    TRUE
  );


SELECT
  IS (
    (
      current_setting('ovw.narrow')::jsonb #>> '{metrics,expiring_entitlements}'
    )::integer,
    0,
    'B6 the window is honoured: nothing expires within 4 days'
  );


SELECT
  set_config('ovw.wide', ops.get_ops_overview (6)::text, TRUE);


SELECT
  IS (
    (
      current_setting('ovw.wide')::jsonb #>> '{metrics,expiring_entitlements}'
    )::integer,
    1,
    'B7 a 6 day window catches only the licence'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,open_tickets}'
    )::integer,
    2,
    'B8 closed tickets are excluded from open tickets'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,waiting_tickets}'
    )::integer,
    1,
    'B9 waiting tickets are counted on their own'
  );


SELECT
  IS (
    (
      current_setting('ovw.delivery')::jsonb #>> '{metrics,failed_sync_commands}'
    )::integer,
    1,
    'B10 only the latest command per mapping decides a sync failure'
  );


-- ── C：金额与「同一口径」（切到财务运营）────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b2","role":"authenticated"}',
    TRUE
  );


SELECT
  set_config(
    'ovw.finance',
    ops.get_ops_overview ()::text,
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('ovw.finance')::jsonb #> '{amounts}'
    ),
    1,
    'C1 amounts is grouped by currency and only CNY is present'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,total_receivable}'
    )::numeric,
    1900.00::numeric,
    'C2 total receivable is the gross amount'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,settled_receivable}'
    )::numeric,
    200.00::numeric,
    'C3 settled receivable is net of reversals'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,overdue_receivable}'
    )::numeric,
    1000.00::numeric,
    'C4 overdue receivable is the outstanding part of overdue periods'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,upcoming_receivable}'
    )::numeric,
    700.00::numeric,
    'C5 upcoming receivable is the outstanding part of future periods'
  );


-- 这一条是 T-13 的硬验收：总览的逾期金额必须与应收列表的汇总**完全相等**。
-- 两个数各自写一遍 SQL 也能「大致相等」，但只要有一处把 amount 写成
-- outstanding、或漏掉 reversed_amount，就会在某个客户身上差出来，而且不报错。
SELECT
  set_config(
    'ovw.list',
    ops.list_receivables (
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      FALSE,
      'due_date',
      FALSE,
      100,
      0
    )::text,
    TRUE
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,total_receivable}'
    )::numeric,
    (
      current_setting('ovw.list')::jsonb #>> '{summary,total_amount}'
    )::numeric,
    'C6 overview total equals the receivable list summary'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,settled_receivable}'
    )::numeric,
    (
      current_setting('ovw.list')::jsonb #>> '{summary,settled_amount}'
    )::numeric,
    'C7 overview settled equals the receivable list summary'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,overdue_receivable}'
    )::numeric,
    (
      current_setting('ovw.list')::jsonb #>> '{summary,overdue_amount}'
    )::numeric,
    'C8 overview overdue equals the receivable list summary (T-13 acceptance)'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{amounts,0,upcoming_receivable}'
    )::numeric,
    (
      (
        current_setting('ovw.list')::jsonb #>> '{summary,outstanding_amount}'
      )::numeric - (
        current_setting('ovw.list')::jsonb #>> '{summary,overdue_amount}'
      )::numeric
    ),
    'C9 upcoming is exactly the non-overdue part of outstanding'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{metrics,pending_receipt_amount}'
    )::numeric,
    100.00::numeric,
    'C10 pending receipts are the recorded, not yet approved ones'
  );


SELECT
  IS (
    (
      current_setting('ovw.finance')::jsonb #>> '{metrics,unreconciled_amount}'
    )::numeric,
    50.00::numeric,
    'C11 unreconciled receipts are the approved but unallocated ones'
  );


SELECT
  ok (
    (
      current_setting('ovw.finance')::jsonb #> '{restricted_metrics}'
    ) ? 'running_tenants',
    'C12 finance_ops has no tenant.read, so tenant metrics are restricted'
  );


SELECT
  ok (
    NOT (
      current_setting('ovw.finance')::jsonb #> '{metrics}'
    ) ? 'running_tenants',
    'C13 the restricted tenant metric is absent from metrics'
  );


-- ── D：多币种与 partialFailures ─────────────────────────────────────────────
-- 换一个币种之后有两个后果要分开看：`amounts[]` 必须多一行（§2.2 按币种分组），
-- 而 `metrics` 里的两个标量金额只能是 CNY，所以必须有一条 partialFailures
-- 把这层局限说出来——否则那两个数字看起来像「全部」。
RESET ROLE;


INSERT INTO
  ops.receivables (
    id,
    contract_id,
    customer_id,
    period_no,
    due_date,
    amount,
    currency,
    allocated_amount,
    reversed_amount
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f6',
    '00000000-0000-4000-8000-0000000009d1',
    '00000000-0000-4000-8000-0000000009c1',
    4,
    ops.receivable_today () - 1,
    100.00,
    'USD',
    0,
    0
  );


INSERT INTO
  ops.receipts (
    id,
    customer_id,
    contract_id,
    transaction_date,
    amount,
    currency,
    method_code,
    status,
    recorded_by,
    recorded_reason
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000009f7',
    '00000000-0000-4000-8000-0000000009c1',
    '00000000-0000-4000-8000-0000000009d1',
    ops.receivable_today (),
    10.00,
    'USD',
    'bank',
    'recorded',
    '00000000-0000-4000-8000-0000000009a2',
    '总览测试'
  );


SET
  local role authenticated;


SELECT
  set_config('ovw.mixed', ops.get_ops_overview ()::text, TRUE);


SELECT
  IS (
    jsonb_array_length(
      current_setting('ovw.mixed')::jsonb #> '{amounts}'
    ),
    2,
    'D1 a second currency gets its own row'
  );


SELECT
  IS (
    (
      current_setting('ovw.mixed')::jsonb #>> '{amounts,1,currency}'
    ) || ':' || (
      current_setting('ovw.mixed')::jsonb #>> '{amounts,1,overdue_receivable}'
    ),
    'USD:100.00',
    'D2 the USD row carries only the USD amounts'
  );


SELECT
  IS (
    current_setting('ovw.mixed')::jsonb #>> '{partial_failures,0,code}',
    'RECEIPT_CURRENCY_MIX',
    'D3 non-CNY pending receipts surface as a partial failure, not a silent omission'
  );


-- ── E：边界与拒绝 ───────────────────────────────────────────────────────────
SELECT
  IS (
    ops.get_ops_overview (0) ->> 'status',
    'invalid_window',
    'E1 a zero day window is a body error, not a silent clamp'
  );


SELECT
  IS (
    ops.get_ops_overview (366) ->> 'status',
    'invalid_window',
    'E2 the window upper bound is 365'
  );


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000009b3","role":"authenticated"}',
    TRUE
  );


SELECT
  throws_ok (
    'select ops.get_ops_overview ()',
    '42501',
    NULL,
    'E3 an operator without overview.read cannot read the overview'
  );


-- 视图是 owner 权限执行的，但那不等于「谁都能读」：它的 ACL 上必须什么也没有。
SELECT
  throws_ok (
    'select count(*) from ops.v_receivable_status',
    '42501',
    NULL,
    'E4 the shared view is not readable by the business role'
  );


-- ── F：视图本身的口径 ───────────────────────────────────────────────────────
RESET ROLE;


SELECT
  IS (
    (
      SELECT
        entry.outstanding_amount
      FROM
        ops.v_receivable_status AS entry
      WHERE
        entry.id = '00000000-0000-4000-8000-0000000009f2'
    ),
    300.00::numeric,
    'F1 outstanding is amount minus net allocation'
  );


SELECT
  IS (
    (
      SELECT
        entry.status
      FROM
        ops.v_receivable_status AS entry
      WHERE
        entry.id = '00000000-0000-4000-8000-0000000009f1'
    ),
    'overdue',
    'F2 the view derives the same status the receivable list shows'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;