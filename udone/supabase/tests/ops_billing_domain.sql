BEGIN;


SELECT
  plan (50);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 三个运营身份：财务（receivable.read + write）、只读（只有 read）、无角色（两者皆无）。
-- 「财务 + 只读」这一对用来分辨「没权限」与「有读权限但不能写」——只测一个无权限
-- 账号，会把「写守卫没接上」与「整域都没接权限」混成同一个 42501。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000006b1',
    'authenticated',
    'authenticated',
    'billing-finance@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000006b2',
    'authenticated',
    'authenticated',
    'billing-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000006b3',
    'authenticated',
    'authenticated',
    'billing-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000006a1',
    '00000000-0000-4000-8000-0000000006b1',
    'billing-finance@example.test',
    'billing 财务',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000006a2',
    '00000000-0000-4000-8000-0000000006b2',
    'billing-viewer@example.test',
    'billing 只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000006a3',
    '00000000-0000-4000-8000-0000000006b3',
    'billing-norole@example.test',
    'billing 无角色',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000006a1',
  role.id,
  '00000000-0000-4000-8000-0000000006a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'finance_ops';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000006a2',
  role.id,
  '00000000-0000-4000-8000-0000000006a1'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


-- 客户与合同直接写表：这一段的目的不是测客户域/合同域的写路径，是给应收
-- 准备可引用对象。三份合同各自覆盖一种 create_receivable_plan 的入口状态：
-- active（可生成）、draft（不可生成）、active 但已有计划（重复生成）。
INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000006c1',
    'billing 测试客户',
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
    business_note
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000006d1',
    '00000000-0000-4000-8000-0000000006c1',
    'saas',
    'active',
    12000.00,
    'CNY',
    '应收主合同'
  ),
  (
    '00000000-0000-4000-8000-0000000006d2',
    '00000000-0000-4000-8000-0000000006c1',
    'saas',
    'draft',
    5000.00,
    'CNY',
    '草稿合同'
  ),
  (
    '00000000-0000-4000-8000-0000000006d3',
    '00000000-0000-4000-8000-0000000006c1',
    'saas',
    'active',
    3000.00,
    'CNY',
    '已有计划的合同'
  );


-- ── S：状态派生的五档与顺序 ─────────────────────────────────────────────────
-- 直接对着函数断言，不造数据：这五条是列表筛选、详情、合同摘要共同的判据，
-- 用数据去证明它反而绕远（要先造出「收满但已过期」这种行）。
SELECT
  IS (
    ops.receivable_status (
      100,
      100,
      100,
      DATE '2026-01-01',
      DATE '2026-01-02'
    ),
    'reversed',
    'S1 a fully reversed period is reversed even though it was once paid'
  );


SELECT
  IS (
    ops.receivable_status (100, 100, 0, DATE '2026-01-01', DATE '2026-01-02'),
    'paid',
    'S2 fully allocated and past due is paid, not overdue'
  );


SELECT
  IS (
    ops.receivable_status (
      100,
      150,
      50,
      DATE '2026-01-01',
      DATE '2026-01-02'
    ),
    'paid',
    'S3 net allocation (150 - 50) decides, not the gross column'
  );


SELECT
  IS (
    ops.receivable_status (100, 80, 30, DATE '2026-01-01', DATE '2026-01-02'),
    'overdue',
    'S4 a partial reversal that still leaves a net balance does not count as reversed'
  );


SELECT
  IS (
    ops.receivable_status (100, 40, 0, DATE '2026-01-01', DATE '2026-01-02'),
    'overdue',
    'S5 partially collected and past due is overdue, not partial'
  );


SELECT
  IS (
    ops.receivable_status (100, 40, 0, DATE '2026-01-03', DATE '2026-01-02'),
    'partial',
    'S6 partially collected and not yet due is partial'
  );


SELECT
  IS (
    ops.receivable_status (100, 0, 0, DATE '2026-01-03', DATE '2026-01-02'),
    'upcoming',
    'S7 nothing collected and not yet due is upcoming'
  );


SELECT
  IS (
    ops.receivable_today (),
    (now() AT TIME ZONE 'Asia/Shanghai')::date,
    'S8 "today" follows the business timezone, not the server clock date'
  );


-- ── P：权限 ──────────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000006b2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_receivable_plan ('00000000-0000-4000-8000-0000000006d1', '[]'::jsonb)$$,
    '42501',
    NULL,
    'P1 a viewer with receivable.read cannot generate a plan'
  );


SELECT
  throws_ok (
    $$select ops.extend_receivable ('00000000-0000-4000-8000-0000000006ff', DATE '2026-12-31', 'x', 1)$$,
    '42501',
    NULL,
    'P2 a viewer cannot extend a receivable'
  );


SELECT
  IS (
    jsonb_typeof(ops.list_receivables ()),
    'object',
    'P3 the viewer can list receivables'
  );


RESET ROLE;


SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000006b3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.list_receivables ()$$,
    '42501',
    NULL,
    'P4 an operator with no role cannot even read'
  );


RESET ROLE;


-- 后续断言统一以财务身份执行。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000006b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── C：生成计划 ──────────────────────────────────────────────────────────────
SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006ff',
      '[{"dueDate":"2026-12-31","amount":1}]'::jsonb
    ) ->> 'status',
    'contract_not_found',
    'C1 an unknown contract is reported, not raised'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d2',
      '[{"dueDate":"2026-12-31","amount":5000}]'::jsonb
    ) ->> 'status',
    'contract_not_active',
    'C2 a draft contract cannot carry a receivable plan'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d1',
      '[]'::jsonb
    ) ->> 'status',
    'periods_required',
    'C3 an empty period list is refused'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d1',
      '[{"dueDate":"2026-12-31","amount":11999.99}]'::jsonb
    ) ->> 'planned_total',
    '11999.99',
    'C4 when the total does not match, the envelope says how far off it is'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d1',
      '[{"dueDate":"2026-12-31","amount":6000},{"dueDate":"2026-12-31","amount":6000.005}]'::jsonb
    ) ->> 'status',
    'amount_scale_invalid',
    'C5 more than two decimals is refused rather than rounded'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d1',
      '[{"dueDate":"2026-12-31","amount":0}]'::jsonb
    ) ->> 'status',
    'amount_invalid',
    'C6 a zero amount is refused'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d1',
      '[{"amount":6000}]'::jsonb
    ) ->> 'status',
    'due_date_required',
    'C7 a period without a due date is refused'
  );


-- 生成一份三期、合计刚好 12000 的计划。三期的到期日刻意一前一后：
-- 第 1 期已过期、第 2 期更早但也过期（不用于计数）、第 3 期在未来。
-- 合计用 4000 × 3 = 12000，正好等于合同金额。
SELECT
  IS (
    (
      ops.create_receivable_plan (
        '00000000-0000-4000-8000-0000000006d1',
        (
          SELECT
            jsonb_agg(
              jsonb_build_object(
                'dueDate',
                to_char(due, 'YYYY-MM-DD'),
                'amount',
                4000
              )
              ORDER BY
                ord
            )
          FROM
            (
              VALUES
                (1, ops.receivable_today () - 10),
                (2, ops.receivable_today () - 5),
                (3, ops.receivable_today () + 20)
            ) AS periods (ord, due)
        )
      ) ->> 'status'
    ),
    'ok',
    'C8 a plan whose total equals the contract amount is created'
  );


-- 下面三条走 `ops.list_receivables` 而不是直连表：表对 authenticated 连 SELECT
-- 都没授予（读也走 RPC），测试若直连就是在用超级用户证明一件端点层办不到的事。
SELECT
  IS (
    ops.list_receivables (
      p_contract_id => '00000000-0000-4000-8000-0000000006d1'
    ) ->> 'total',
    '3',
    'C9 the plan writes one row per period'
  );


SELECT
  IS (
    (
      SELECT
        string_agg(
          item ->> 'period_no',
          ','
          ORDER BY
            (item ->> 'period_no')::integer
        )
      FROM
        jsonb_array_elements(
          ops.list_receivables (
            p_contract_id => '00000000-0000-4000-8000-0000000006d1'
          ) -> 'items'
        ) AS item
    ),
    '1,2,3',
    'C10 period numbers come from the array order, not from the caller'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1'
      )
    ) #>> '{items,0,currency}',
    'CNY',
    'C11 the currency is inherited from the contract'
  );


SELECT
  IS (
    ops.create_receivable_plan (
      '00000000-0000-4000-8000-0000000006d1',
      '[{"dueDate":"2026-12-31","amount":12000}]'::jsonb
    ) ->> 'status',
    'plan_exists',
    'C12 generating a second plan for the same contract is refused'
  );


-- ── E：展期 ──────────────────────────────────────────────────────────────────
-- 第 2 期（today - 5，未收）用来做「版本不符」与「成功展期」；
-- 第 1 期先标记为收满，用来做「已结清不可展期」。
RESET ROLE;


-- 后面所有断言都以 authenticated 身份跑，而表对 authenticated 没有 SELECT：
-- 需要 id 的地方若写 `(select id from ops.receivables ...)`，会得到
-- `permission denied for table receivables`——那不是被测代码的问题，是测试
-- 自己在用端点拿不到的权限。所以先把 id 提到会话变量里，之后一律
-- `current_setting(...)` 取用，与端点同一条路。
SELECT
  set_config(
    'billing.p1',
    (
      SELECT
        id::text
      FROM
        ops.receivables
      WHERE
        contract_id = '00000000-0000-4000-8000-0000000006d1'
        AND period_no = 1
    ),
    TRUE
  ),
  set_config(
    'billing.p2',
    (
      SELECT
        id::text
      FROM
        ops.receivables
      WHERE
        contract_id = '00000000-0000-4000-8000-0000000006d1'
        AND period_no = 2
    ),
    TRUE
  ),
  set_config(
    'billing.p3',
    (
      SELECT
        id::text
      FROM
        ops.receivables
      WHERE
        contract_id = '00000000-0000-4000-8000-0000000006d1'
        AND period_no = 3
    ),
    TRUE
  ),
  set_config(
    'billing.contract_no',
    (
      SELECT
        contract_no
      FROM
        ops.contracts
      WHERE
        id = '00000000-0000-4000-8000-0000000006d1'
    ),
    TRUE
  );


UPDATE ops.receivables
SET
  allocated_amount = amount
WHERE
  contract_id = '00000000-0000-4000-8000-0000000006d1'
  AND period_no = 1;


SET
  local role authenticated;


SELECT
  IS (
    ops.extend_receivable (
      current_setting('billing.p1')::uuid,
      ops.receivable_today () + 40,
      '客户申请延后',
      1
    ) ->> 'status',
    'receivable_settled',
    'E1 a settled receivable cannot be extended'
  );


SELECT
  IS (
    ops.extend_receivable (
      current_setting('billing.p2')::uuid,
      ops.receivable_today () + 40,
      '客户申请延后',
      99
    ) ->> 'status',
    'version_mismatch',
    'E2 a stale version is reported instead of overwriting a concurrent extension'
  );


SELECT
  IS (
    ops.extend_receivable (
      current_setting('billing.p2')::uuid,
      ops.receivable_today () - 6,
      '客户申请延后',
      1
    ) ->> 'status',
    'invalid_due_date',
    'E3 a new due date that is not later than the current one is refused'
  );


SELECT
  IS (
    ops.extend_receivable (
      current_setting('billing.p2')::uuid,
      ops.receivable_today () + 40,
      '   ',
      1
    ) ->> 'status',
    'reason_required',
    'E4 a blank reason is refused'
  );


SELECT
  IS (
    ops.extend_receivable (
      '00000000-0000-4000-8000-0000000006ff',
      ops.receivable_today () + 40,
      '客户申请延后',
      1
    ) ->> 'status',
    'receivable_not_found',
    'E5 an unknown receivable is reported, not raised'
  );


SELECT
  IS (
    ops.extend_receivable (
      current_setting('billing.p3')::uuid,
      ops.receivable_today () + 40,
      '客户申请延后',
      1
    ) ->> 'status',
    'ok',
    'E6 an unsettled receivable can be extended'
  );


SELECT
  IS (
    (
      ops.get_receivable (current_setting('billing.p3')::uuid)
    ) #>> '{receivable,version}',
    '2',
    'E7 the extension bumps the optimistic-lock version'
  );


SELECT
  IS (
    (
      ops.get_receivable (current_setting('billing.p3')::uuid)
    ) #>> '{extensions,0,previous_due_date}',
    to_char(ops.receivable_today () + 20, 'YYYY-MM-DD'),
    'E8 the extension keeps the original due date'
  );


-- ── L：列表与汇总 ────────────────────────────────────────────────────────────
-- 此刻三期分别是：paid(4000)、reversed 无 / overdue(4000)、upcoming(4000，已展期到 +40)。
SELECT
  IS (
    ops.list_receivables (
      p_contract_id => '00000000-0000-4000-8000-0000000006d1'
    ) ->> 'total',
    '3',
    'L1 the list returns every period of the contract'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1'
      )
    ) #>> '{summary,total_amount}',
    '12000.00',
    'L2 the summary counts the planned total'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1'
      )
    ) #>> '{summary,settled_amount}',
    '4000.00',
    'L3 the settled total only counts paid periods'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1'
      )
    ) #>> '{summary,outstanding_amount}',
    '8000.00',
    'L4 the outstanding total excludes paid periods'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1',
        p_statuses => ARRAY['overdue']
      )
    ) ->> 'total',
    '1',
    'L5 filtering by status uses the derived value, not a stored column'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1',
        p_overdue_only => TRUE
      )
    ) ->> 'total',
    '1',
    'L6 overdueOnly is the same predicate as status=overdue'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1',
        p_sort => 'due_date',
        p_sort_desc => TRUE,
        p_limit => 2
      )
    ) #>> '{items,0,period_no}',
    '3',
    'L7 sorting by due date descending starts from the latest period'
  );


SELECT
  IS (
    (
      ops.list_receivables (
        p_contract_id => '00000000-0000-4000-8000-0000000006d1',
        p_limit => 2
      )
    ) ->> 'total',
    '3',
    'L8 total is the filtered count, not the page size'
  );


-- ── G：详情 ──────────────────────────────────────────────────────────────────
SELECT
  IS (
    jsonb_array_length(
      (
        ops.get_receivable (current_setting('billing.p3')::uuid)
      ) -> 'extensions'
    ),
    1,
    'G1 the detail carries the extension history'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        ops.get_receivable (current_setting('billing.p2')::uuid)
      ) -> 'allocations'
    ),
    0,
    'G2 allocations stay an empty array while the receipt tables do not exist'
  );


SELECT
  IS (
    ops.get_receivable ('00000000-0000-4000-8000-0000000006ff') ->> 'status',
    'receivable_not_found',
    'G3 an unknown receivable is reported in the envelope'
  );


-- ── K：合同详情里的应收摘要 ──────────────────────────────────────────────────
-- T-06 落地时这里透传的是原始行（没有 status / outstanding / contract_no）。
-- 本域落地后必须换成与 §5.5 列表项同形的摘要，否则前端在合同详情里拿到的
-- 是另一套字段名——同一屏两个形状，是查起来最费时的那类缺陷。
SELECT
  IS (
    (
      ops.get_contract ('00000000-0000-4000-8000-0000000006d1')
    ) #>> '{receivables,0,status}',
    'paid',
    'K1 the contract detail exposes the derived status of each period'
  );


SELECT
  IS (
    (
      ops.get_contract ('00000000-0000-4000-8000-0000000006d1')
    ) #>> '{receivables,2,contract_no}',
    current_setting('billing.contract_no'),
    'K2 the contract detail rows carry the contract number'
  );


SELECT
  IS (
    (
      ops.get_contract ('00000000-0000-4000-8000-0000000006d1')
    ) #>> '{receivables,2,outstanding}',
    '4000.00',
    'K3 the contract detail rows carry the outstanding amount'
  );


-- ── R：表约束与直连权限 ──────────────────────────────────────────────────────
SELECT
  throws_ok (
    $$insert into ops.receivables (contract_id, customer_id, period_no, due_date, amount, currency)
      values ('00000000-0000-4000-8000-0000000006d3', '00000000-0000-4000-8000-0000000006c1', 1,
              DATE '2026-12-31', 100, 'CNY')$$,
    '42501',
    NULL,
    'R1 authenticated cannot insert into receivables directly'
  );


RESET ROLE;


SELECT
  throws_ok (
    $$insert into ops.receivables (contract_id, customer_id, period_no, due_date, amount, currency)
      values ('00000000-0000-4000-8000-0000000006d1', '00000000-0000-4000-8000-0000000006c1', 1,
              DATE '2026-12-31', 100, 'CNY')$$,
    '23505',
    NULL,
    'R2 period numbers are unique inside a contract'
  );


SELECT
  throws_ok (
    $$insert into ops.receivables (contract_id, customer_id, period_no, due_date, amount, currency, allocated_amount)
      values ('00000000-0000-4000-8000-0000000006d3', '00000000-0000-4000-8000-0000000006c1', 1,
              DATE '2026-12-31', 100, 'CNY', 200)$$,
    '23514',
    NULL,
    'R3 allocation cannot exceed the period amount'
  );


SELECT
  throws_ok (
    $$insert into ops.receivable_extensions (receivable_id, previous_due_date, new_due_date, reason)
      values ((select id from ops.receivables where contract_id = '00000000-0000-4000-8000-0000000006d1' and period_no = 3),
              DATE '2026-12-31', DATE '2026-12-31', '同日展期')$$,
    '23514',
    NULL,
    'R4 an extension must move the due date forward'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;