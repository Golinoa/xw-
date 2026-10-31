BEGIN;


SELECT
  plan (28);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 两个身份：商务运营（receivable / entitlement / tenant / deployment / contract
-- 都有，唯独没有写权限）与无角色。报表是只读域，所以「能不能读」就是全部分界。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000007b1',
    'authenticated',
    'authenticated',
    'reports-sales@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000007b2',
    'authenticated',
    'authenticated',
    'reports-norole@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007a1',
    '00000000-0000-4000-8000-0000000007b1',
    'reports-sales@example.test',
    'reports 商务',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007a2',
    '00000000-0000-4000-8000-0000000007b2',
    'reports-norole@example.test',
    'reports 无角色',
    'active'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000007a1'::uuid,
  role.id,
  '00000000-0000-4000-8000-0000000007a1'::uuid
FROM
  ops.roles AS role
WHERE
  role.code = 'sales_ops';


INSERT INTO
  ops.customers (id, name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007c1',
    'reports 客户甲',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007c2',
    'reports 客户乙',
    'active'
  );


INSERT INTO
  ops.products (id, code, name, lifecycle_status)
VALUES
  (
    '00000000-0000-4000-8000-0000000007e1',
    'PRD-RPT',
    'reports 测试产品',
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
    '00000000-0000-4000-8000-0000000007e2',
    '00000000-0000-4000-8000-0000000007e1',
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
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    'saas',
    'active',
    1900.00,
    'CNY',
    DATE '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007c2',
    'saas',
    'active',
    600.00,
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
    '00000000-0000-4000-8000-0000000007d3',
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007e1',
    '00000000-0000-4000-8000-0000000007e2',
    'saas',
    'periodic',
    1,
    1900.00,
    1900.00,
    '标准版',
    1
  ),
  (
    '00000000-0000-4000-8000-0000000007d4',
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007e1',
    '00000000-0000-4000-8000-0000000007e2',
    'saas',
    'periodic',
    1,
    600.00,
    600.00,
    '标准版',
    1
  );


-- 甲客户：逾期 1000（已收 400，尚欠 600）+ 未来 900（已收 200，尚欠 700）；
-- 乙客户：未来 600。
--
-- 逾期那条**必须部分已收**：金额 1000 和尚欠 600 不等，「逾期金额取尚欠」才
-- 和「取应收总额」区分得开。第一版这条没收过钱，两个算法给同一个 1000，
-- 把 `overdue_amount` 改成 `sum(amount)` 全绿——夹具缺一格，断言就等于没写。
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
    '00000000-0000-4000-8000-0000000007f1',
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    1,
    ops.receivable_today () - 5,
    1000.00,
    'CNY',
    400.00,
    0
  ),
  (
    '00000000-0000-4000-8000-0000000007f2',
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007c1',
    2,
    ops.receivable_today () + 20,
    900.00,
    'CNY',
    200.00,
    0
  ),
  (
    '00000000-0000-4000-8000-0000000007f3',
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007c2',
    1,
    ops.receivable_today () + 40,
    600.00,
    'CNY',
    0,
    0
  );


-- 权益：订阅 5 天后到期、授权 20 天后到期。两者分属两张表，用来验证
-- `subject_type` 的筛选项真的落在 union 的两支上。
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
    '00000000-0000-4000-8000-0000000007a3',
    '00000000-0000-4000-8000-0000000007c1',
    '00000000-0000-4000-8000-0000000007d1',
    '00000000-0000-4000-8000-0000000007d3',
    '00000000-0000-4000-8000-0000000007e1',
    '00000000-0000-4000-8000-0000000007e2',
    'yearly',
    ops.receivable_today () - 360,
    ops.receivable_today () + 5,
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
    '00000000-0000-4000-8000-0000000007a4',
    '00000000-0000-4000-8000-0000000007c2',
    '00000000-0000-4000-8000-0000000007d2',
    '00000000-0000-4000-8000-0000000007d4',
    'term',
    ops.receivable_today () - 345,
    ops.receivable_today () + 20,
    'active'
  );


-- 租户：甲映射最新命令 succeeded（不进报表）、乙映射最新命令 failed（进报表）。
-- 第二条 attempt 让 `last_attempt_at` 有值可断。
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
    '00000000-0000-4000-8000-0000000007b3',
    '00000000-0000-4000-8000-0000000007c1',
    '00000000-0000-4000-8000-0000000007e1',
    '00000000-0000-4000-8000-0000000007f8',
    'active',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000007b4',
    '00000000-0000-4000-8000-0000000007c2',
    '00000000-0000-4000-8000-0000000007e1',
    NULL,
    'pending',
    NULL
  );


-- 甲映射刻意排成「先失败、后成功」：它的**最新**一条命令是 succeeded，
-- 所以它不该出现在报表里。没有这一行，`status = 'failed'` 放在取最新之前还是
-- 之后都得到同一个结果，S1 就是一条永远为真的断言。
INSERT INTO
  ops.tenant_commands (
    id,
    idempotency_key,
    mapping_id,
    command_type,
    reason,
    status,
    attempt_count,
    last_error_category,
    created_at,
    completed_at
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007c5',
    'reports-failed-then-fixed',
    '00000000-0000-4000-8000-0000000007b3',
    'provision',
    '报表测试：失败后重试成功',
    'failed',
    1,
    'transient',
    timestamptz '2026-10-01 02:00:00+00',
    timestamptz '2026-10-01 02:00:04+00'
  ),
  (
    '00000000-0000-4000-8000-0000000007c3',
    'reports-success',
    '00000000-0000-4000-8000-0000000007b3',
    'activate',
    '报表测试',
    'succeeded',
    1,
    NULL,
    timestamptz '2026-10-31 01:00:00+00',
    timestamptz '2026-10-31 01:00:03+00'
  ),
  (
    '00000000-0000-4000-8000-0000000007c4',
    'reports-failed',
    '00000000-0000-4000-8000-0000000007b4',
    'provision',
    '报表测试',
    'failed',
    2,
    'permanent',
    timestamptz '2026-10-31 03:00:00+00',
    timestamptz '2026-10-31 03:00:05+00'
  );


INSERT INTO
  ops.tenant_command_attempts (
    command_id,
    attempt_no,
    started_at,
    finished_at,
    outcome,
    error_category
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007c4',
    1,
    timestamptz '2026-10-30 02:00:00+00',
    timestamptz '2026-10-30 02:00:05+00',
    'failed',
    'transient'
  ),
  (
    '00000000-0000-4000-8000-0000000007c4',
    2,
    timestamptz '2026-10-31 02:00:00+00',
    timestamptz '2026-10-31 02:00:03+00',
    'failed',
    'permanent'
  );


-- 部署：两台在管（1.4.0 / 1.5.0）、一台没版本、一台已退役（不该出现）。
INSERT INTO
  ops.deployment_instances (
    id,
    customer_id,
    name,
    deployment_type,
    current_version,
    status,
    go_live_on
  )
VALUES
  (
    '00000000-0000-4000-8000-0000000007e3',
    '00000000-0000-4000-8000-0000000007c1',
    '甲生产',
    'private',
    '1.4.0',
    'active',
    DATE '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000007e4',
    '00000000-0000-4000-8000-0000000007c2',
    '乙生产',
    'private',
    '1.5.0',
    'maintenance',
    DATE '2026-01-01'
  ),
  (
    '00000000-0000-4000-8000-0000000007e5',
    '00000000-0000-4000-8000-0000000007c2',
    '乙灾备',
    'dedicated',
    NULL,
    'active',
    DATE '2026-02-01'
  ),
  (
    '00000000-0000-4000-8000-0000000007e6',
    '00000000-0000-4000-8000-0000000007c1',
    '甲旧机',
    'private',
    '1.2.0',
    'retired',
    DATE '2025-01-01'
  );


-- ── 切到商务运营身份 ────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000007b1","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


-- ── R：应收报表 ─────────────────────────────────────────────────────────────
SELECT
  set_config(
    'rpt.byCustomer',
    ops.report_receivables ()::text,
    TRUE
  );


SELECT
  IS (
    current_setting('rpt.byCustomer')::jsonb #>> '{group_by}',
    'customer',
    'R1 the default grouping is by customer'
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('rpt.byCustomer')::jsonb #> '{rows}'
    ),
    2,
    'R2 two customers owe money'
  );


SELECT
  IS (
    current_setting('rpt.byCustomer')::jsonb #>> '{rows,0,label}',
    'reports 客户甲',
    'R3 the biggest debtor comes first'
  );


SELECT
  IS (
    (
      current_setting('rpt.byCustomer')::jsonb #>> '{rows,0,outstanding_amount}'
    )::numeric,
    1300.00::numeric,
    'R4 the group carries the outstanding amount, not the gross amount'
  );


SELECT
  IS (
    (
      current_setting('rpt.byCustomer')::jsonb #>> '{totals,total_amount}'
    )::numeric,
    2500.00::numeric,
    'R5 totals sum every currency-matching receivable'
  );


SELECT
  IS (
    (
      current_setting('rpt.byCustomer')::jsonb #>> '{totals,overdue_amount}'
    )::numeric,
    600.00::numeric,
    'R6 the overdue part is what is still owed, not the gross of the overdue rows'
  );


SELECT
  set_config(
    'rpt.list',
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
      current_setting('rpt.byCustomer')::jsonb #>> '{totals,overdue_amount}'
    )::numeric,
    (
      current_setting('rpt.list')::jsonb #>> '{summary,overdue_amount}'
    )::numeric,
    'R7 the report and the receivable list agree on overdue (T-13 acceptance)'
  );


-- 按 key 定位那一桶，不用 `rows,0`：行的顺序是「欠得多的在前」，
-- 而逾期一旦部分收回，第一名就会换成未来的那一桶——用下标断言的测试会在
-- 夹具一动就红，但从错误的原因红。
SELECT
  IS (
    (
      SELECT
        (entry ->> 'outstanding_amount')::numeric
      FROM
        jsonb_array_elements(
          ops.report_receivables (NULL, NULL, NULL, NULL, NULL, 'dueMonth') #> '{rows}'
        ) AS entry
      WHERE
        entry ->> 'key' = to_char(ops.receivable_today () - 5, 'YYYY-MM')
    ),
    600.00::numeric,
    'R8 grouping by due month keys on YYYY-MM'
  );


SELECT
  IS (
    ops.report_receivables (NULL, NULL, NULL, NULL, NULL, 'contract') #>> '{group_by}',
    'contract',
    'R9 group_by is echoed back'
  );


SELECT
  IS (
    ops.report_receivables (NULL, NULL, NULL, NULL, NULL, 'quarter') ->> 'status',
    'invalid_group_by',
    'R10 an unknown grouping is a body error, not an empty report'
  );


SELECT
  IS (
    ops.report_receivables (
      NULL,
      NULL,
      ARRAY['overdue'],
      NULL,
      NULL,
      'customer'
    ) #>> '{totals,count}',
    '1',
    'R11 the status filter narrows both rows and totals'
  );


-- 整块比而不是「有没有 group_by 这个键」：第一版这里写的是 `? 'group_by'`，
-- 于是 SQL 和断言一起把键名写成 snake_case，而 `protocol.ts` 读的是 `groupBy`——
-- 三处单测与集成测试全 503，pgTAP 却是绿的。「断言太松」比「断言错」更难发现：
-- 它不报错，它只是允许了一个错。
SELECT
  IS (
    ops.report_receivables (NULL, NULL, NULL, NULL, NULL, 'customer') #> '{filters_echo}',
    jsonb_build_object(
      'customerId',
      NULL,
      'contractId',
      NULL,
      'status',
      NULL,
      'dueFrom',
      NULL,
      'dueTo',
      NULL,
      'groupBy',
      'customer'
    ),
    'R12 filters_echo travels with the report, with the exact keys the API reads'
  );


-- ── E：临期权益 ─────────────────────────────────────────────────────────────
SELECT
  set_config(
    'rpt.expiring',
    ops.report_expiring_entitlements ()::text,
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('rpt.expiring')::jsonb #> '{rows}'
    ),
    2,
    'E1 both a subscription and a licence expire inside the default window'
  );


SELECT
  IS (
    current_setting('rpt.expiring')::jsonb #>> '{rows,0,subject_type}',
    'subscription',
    'E2 the earliest expiry comes first regardless of subject type'
  );


SELECT
  IS (
    (
      current_setting('rpt.expiring')::jsonb #>> '{rows,0,days_remaining}'
    )::integer,
    5,
    'E3 days_remaining is derived from today, not stored'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.report_expiring_entitlements (30, 'licence') #> '{rows}'
    ),
    1,
    'E4 subject_type=licence excludes subscriptions'
  );


SELECT
  IS (
    ops.report_expiring_entitlements (30, 'voucher') ->> 'status',
    'invalid_subject_type',
    'E5 an unknown subject type is a body error, not an empty list'
  );


SELECT
  IS (
    ops.report_expiring_entitlements (0, NULL) ->> 'status',
    'invalid_window',
    'E6 the window is bounded at 1 day'
  );


-- ── S：同步失败 ─────────────────────────────────────────────────────────────
SELECT
  set_config(
    'rpt.sync',
    ops.report_tenant_sync_failures ()::text,
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(current_setting('rpt.sync')::jsonb #> '{rows}'),
    1,
    'S1 only the mapping whose latest command failed is reported'
  );


SELECT
  ok (
    (
      current_setting('rpt.sync')::jsonb #>> '{rows,0,mapping,mapping_no}'
    ) ~ '^TM-[0-9]{6}$',
    'S2 the row names the mapping, not just the command'
  );


SELECT
  IS (
    (
      current_setting('rpt.sync')::jsonb #>> '{rows,0,last_attempt_at}'
    )::timestamptz,
    timestamptz '2026-10-31 02:00:00+00',
    'S3 last_attempt_at comes from the attempts table, not the command'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.report_tenant_sync_failures ('activate', NULL) #> '{rows}'
    ),
    0,
    'S4 command_type filters the report'
  );


SELECT
  IS (
    ops.report_tenant_sync_failures ('delete', NULL) ->> 'status',
    'invalid_command_type',
    'S5 an unknown command type is a body error'
  );


-- 和总览的 `failedSyncCommands` 必须是同一个数。两个地方各自写一遍「最新一条
-- 是不是 failed」，只要 WHERE 的位置差一步就会得出两个数——而两个数都不报错，
-- 只有把「相等」写成断言才看得见（§10 口径统一；第一版报表就是错的，总览是对的）。
SELECT
  IS (
    jsonb_array_length(current_setting('rpt.sync')::jsonb #> '{rows}'),
    (
      ops.get_ops_overview (30) #>> '{metrics,failed_sync_commands}'
    )::integer,
    'S6 the report and the overview agree on the failed-sync count (T-13 acceptance)'
  );


-- ── D：部署版本分布 ─────────────────────────────────────────────────────────
SELECT
  set_config(
    'rpt.versions',
    ops.report_deployment_versions ()::text,
    TRUE
  );


SELECT
  IS (
    jsonb_array_length(
      current_setting('rpt.versions')::jsonb #> '{rows}'
    ),
    2,
    'D1 only registered versions get a row'
  );


SELECT
  IS (
    (
      current_setting('rpt.versions')::jsonb #>> '{unknown_version_count}'
    )::integer,
    1,
    'D2 an instance without a version is counted separately'
  );


SELECT
  ok (
    NOT current_setting('rpt.versions')::jsonb #> '{rows}' @> '[{"version": "1.2.0"}]'::jsonb,
    'D3 a retired instance is not part of the version distribution'
  );


SELECT
  IS (
    (
      ops.report_deployment_versions (NULL, ARRAY['maintenance']) #>> '{rows,0,instance_count}'
    )::integer,
    1,
    'D4 status narrows the distribution'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;