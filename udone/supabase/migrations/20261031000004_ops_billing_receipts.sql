-- 运营 billing 域（下半）：四张表 + 十四个函数（契约 §3.4、§5.5 后八条）。
--
-- 本域是整条线风险最高的一处：一次核销要同时改 `receipts` 的状态、多行
-- `receivables` 的余额、插入分配流水、写审计，四件事必须在同一个事务里。
-- 设计要点：
--
-- 1. **先修正 `receivables` 的两条 CHECK，因为契约自相矛盾。** §3.4 表的约束写
--    `CHECK(allocated_amount BETWEEN 0 AND amount)`，而同一节的不变量 2 写
--    `allocated_amount + 本次 <= amount + reversed_amount`。前者说 allocated 是
--    「净额」，后者说它是「累计毛额」。用净额会死掉两处：`reversed_amount` 永远
--    为 0（那 `reversed` 这个状态就不可达），且「全额核销 → 撤销一部分 → 重新
--    核销」这条正常路径会撞 CHECK。用毛额则两条式子都成立、`reversed` 状态也
--    有了意义（核销被全部撤销时显示 `reversed`）。
--    这里改约束为净额不变量，不改函数、不改原型：
--      `0 <= reversed_amount <= allocated_amount` 且
--      `allocated_amount <= amount + reversed_amount`
--    两条合起来就是 `0 <= allocated - reversed <= amount`，与契约的状态派生
--    公式 `net = allocated - reversed` 严格等价。契约正文待回写（C-109）。
--
-- 2. **登记人 ≠ 审核人由数据库兜底，不是只靠应用层判断。** 契约 §3.4 的
--    `receipts` 有 `CHECK(approved_by <> recorded_by)`。应用层还要在自审时回
--    403 `FORBIDDEN` + `details.rule='SEGREGATION_OF_DUTY'`（契约 §6.4）——
--    两条都要，因为 CHECK 只给得出 23514，说不出「为什么不行」；而只靠应用层，
--    任何一条绕过端点的写入路径都能自审。
--
-- 3. **核销必须锁行，且按 id 排序锁。** 契约 §3.4 的不变量要 `SELECT ... FOR
--    UPDATE`。两个并发核销如果以不同顺序锁同一组应收，会互相等成死锁；先按
--    `id` 排序再加锁，把「谁先谁后」变成确定的。
--
-- 4. **超额校验写两遍：RPC 里一次，表约束一次。** RPC 那一次是为了给出
--    `RECEIPT_EXCEEDED` / `RECEIVABLE_EXCEEDED` 这种能看懂的原因；表约束是给
--    「绕过 RPC 的写入」兜底。只留 RPC 那次，等于赌没有第二条写入路径。
--
-- 5. **跨客户/跨币种核销在数据库层无法成立，但错误必须干净。** 复合外键
--    `(receipt_id, customer_id, currency)` / `(receivable_id, customer_id, currency)`
--    让跨客户、跨币种的行插不进去；可外键只会抛 23503，运营端看到的是
--    「约束冲突」而不是「这笔钱和这期应收不是同一个客户」。所以插入前显式
--    比对，给 400 `CUSTOMER_MISMATCH` / `CURRENCY_MISMATCH`，外键只作兜底。
--
-- 6. **`reversed_amount` 单调增，`allocated_amount` 也单调增。** 撤销核销写
--    反向流水、把 `reversed_amount` 加上去，不回退 `allocated_amount`：核销
--    记录本身要保留（契约 §3.4「不覆盖原流水」），「核销过又被撤销」这件事
--    只能靠两个数之差表达。
--
-- 7. **审计在这一域第一次真正落地。** 契约 §6.1 把收款登记/审核/核销/核销撤销/
--    退款列进「必填 reason」的高风险动作，§6.4 又点名 `receipt.rejected` 这个词。
--    前面四个域（客户 / catalog / 合同 / billing 上半）都只建了 `ops.write_audit`
--    却一处都没调用——本域按契约把这些词真正写进 `audit_events`，其余四域的
--    缺口仍挂在 `o-audit-write` 上。
--
-- 8. **退款不改核销。** 退款是「钱退回去」，核销是「这笔钱抵了哪几期」。契约
--    §3.4 的退款表没有任何指向 `receivables` 的列，也没有要求回退核销额；
--    退了钱之后应收是否重新变成欠款，属于合同变更/冲正流程的事。这里照契约
--    实现，不擅自回退——越权回退会让「已收款」这个报表口径在没有书面依据的
--    情况下变动。
--
-- 9. **可退款净额取自「已核销净额」，不取自收款金额。** 契约 §3.4 写「累计
--    退款额 ≤ 对应收款已核销净额」。这条同时挡住了「未审核的收款退款」：
--    `recorded` 的收款核销净额为 0，可退额就是 0，无需再加一条状态判断。
-- ── 0. 修正 receivables 的核销余额约束（见设计要点 1）────────────────────
--
-- 按**定义**找旧约束，不按名字：`CHECK (allocated_amount BETWEEN 0 AND amount)`
-- 引用了两列，Postgres 不会把它命名成 `receivables_allocated_amount_check`，
-- 而是回落成表级的 `receivables_check` / `receivables_check1`（带序号，取决于
-- 建表时的顺序）。按名字删会「静默什么都没删」——`IF EXISTS` 连错都不报，
-- 最后两条旧约束和两条新约束同时生效，净额不变量又被打回原形。
DO $$
declare
  entry record;
begin
  for entry in
    select con.conname, pg_get_constraintdef(con.oid) as definition
    from pg_constraint as con
    where con.conrelid = 'ops.receivables'::regclass
      and con.contype = 'c'
  loop
    -- 只删「提到核销两列余额」的旧约束；`amount > 0`、`period_no >= 1`、
    -- `version >= 1` 这些单列约束不碰。
    if entry.definition like '%allocated_amount%'
      or entry.definition like '%reversed_amount%' then
      execute format('alter table ops.receivables drop constraint %I', entry.conname);
    end if;
  end loop;
end;
$$;


ALTER TABLE ops.receivables
ADD CONSTRAINT receivables_reversed_within_allocated CHECK (
  reversed_amount >= 0
  AND reversed_amount <= allocated_amount
);


ALTER TABLE ops.receivables
ADD CONSTRAINT receivables_allocated_within_amount CHECK (allocated_amount <= amount + reversed_amount);


CREATE SEQUENCE ops.receipt_no_seq AS bigint START
WITH
  1;


CREATE SEQUENCE ops.refund_no_seq AS bigint START
WITH
  1;


-- ── 1. 收款登记 ─────────────────────────────────────────────────────────────
CREATE TABLE ops.receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no text NOT NULL DEFAULT (
    'SK-' || lpad(nextval('ops.receipt_no_seq')::text, 6, '0')
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  -- 可空 = 未指定合同（客户先打款、后指认合同）。有值时必与客户一致。
  contract_id uuid REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  transaction_date date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  -- 不给默认值：币种由合同或调用方显式给出，默认 CNY 会让「美元合同收了一笔
  -- 没写币种的钱」悄悄记成人民币，而复合外键这时才发现两边不一致。
  currency char(3) NOT NULL,
  method_code text NOT NULL CHECK (length(btrim(method_code)) > 0),
  reference_no text,
  voucher_ref text,
  status text NOT NULL DEFAULT 'recorded' CHECK (
    status IN (
      'recorded',
      'pending_reconcile',
      'reconciled',
      'reversed',
      'refunded'
    )
  ),
  recorded_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES ops.operators (id) ON DELETE RESTRICT,
  approved_at timestamptz,
  -- 契约 §6.1：收款登记属「必填 reason」的高风险动作。落库而不是只写审计，
  -- 是因为审计页与收款详情页要看的是同一句话，两处各自存一份迟早不一致。
  recorded_reason text NOT NULL CHECK (length(btrim(recorded_reason)) > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipts_receipt_no_key UNIQUE (receipt_no),
  -- 复合外键的落点：核销分配的客户与币种从收款行继承，跨客户/跨币种插不进来。
  CONSTRAINT receipts_customer_currency_key UNIQUE (id, customer_id, currency),
  -- 登记人不能自审。应用层另给 403 + SEGREGATION_OF_DUTY，这条只作兜底。
  CONSTRAINT receipts_segregation_of_duty CHECK (
    approved_by IS NULL
    OR approved_by <> recorded_by
  ),
  -- approved_by 与 approved_at 成对：只有一个有值的行是「审了一半」，
  -- 列表按 approvedAt 排序时会把它排到最前或最后，看不出它是脏数据。
  CONSTRAINT receipts_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);


CREATE INDEX receipts_customer_status_idx ON ops.receipts (customer_id, status);


CREATE INDEX receipts_transaction_date_idx ON ops.receipts (transaction_date);


CREATE INDEX receipts_status_idx ON ops.receipts (status);


CREATE INDEX receipts_reference_no_idx ON ops.receipts (reference_no)
WHERE
  reference_no IS NOT NULL;


-- ── 2. 核销分配（仅 INSERT）──────────────────────────────────────────────────
CREATE TABLE ops.receipt_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  customer_id uuid NOT NULL,
  currency char(3) NOT NULL,
  allocated_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  allocated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT receipt_allocations_receipt_fkey FOREIGN KEY (receipt_id, customer_id, currency) REFERENCES ops.receipts (id, customer_id, currency) ON DELETE RESTRICT,
  CONSTRAINT receipt_allocations_receivable_fkey FOREIGN KEY (receivable_id, customer_id, currency) REFERENCES ops.receivables (id, customer_id, currency) ON DELETE RESTRICT
);


CREATE INDEX receipt_allocations_receipt_idx ON ops.receipt_allocations (receipt_id, allocated_at);


CREATE INDEX receipt_allocations_receivable_idx ON ops.receipt_allocations (receivable_id);


-- ── 3. 核销撤销（仅 INSERT，反向流水）────────────────────────────────────────
CREATE TABLE ops.receipt_allocation_reversals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  allocation_id uuid NOT NULL REFERENCES ops.receipt_allocations (id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  reversed_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX receipt_allocation_reversals_allocation_idx ON ops.receipt_allocation_reversals (allocation_id, created_at);


-- ── 4. 退款登记 ─────────────────────────────────────────────────────────────
CREATE TABLE ops.refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  refund_no text NOT NULL DEFAULT (
    'RT-' || lpad(nextval('ops.refund_no_seq')::text, 6, '0')
  ),
  receipt_id uuid NOT NULL REFERENCES ops.receipts (id) ON DELETE RESTRICT,
  contract_id uuid REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL,
  refund_date date NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  external_voucher_ref text,
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded', 'approved', 'cancelled')),
  handled_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  approved_by uuid REFERENCES ops.operators (id) ON DELETE RESTRICT,
  approved_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT refunds_refund_no_key UNIQUE (refund_no),
  CONSTRAINT refunds_approval_pair CHECK ((approved_by IS NULL) = (approved_at IS NULL))
);


CREATE INDEX refunds_receipt_idx ON ops.refunds (receipt_id, status);


CREATE INDEX refunds_customer_idx ON ops.refunds (customer_id, refund_date);


CREATE INDEX refunds_status_idx ON ops.refunds (status);


-- 收款的已核销净额 = 分配合计 - 撤销合计。列表的 `allocatedAmount`、核销时的
-- 可分配额、退款时的可退额、撤销收款时的 HAS_ALLOCATIONS 判断，四处共用这一个
-- 定义。各写一份的结果是「列表显示已核销 800，退款时却说可退 0」这类对不上账。
CREATE OR REPLACE FUNCTION ops.receipt_allocated_net (p_receipt_id uuid) returns numeric language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce((
    select sum(allocation.amount)
    from ops.receipt_allocations as allocation
    where allocation.receipt_id = p_receipt_id
  ), 0) - coalesce((
    select sum(reversal.amount)
    from ops.receipt_allocation_reversals as reversal
    join ops.receipt_allocations as allocation on allocation.id = reversal.allocation_id
    where allocation.receipt_id = p_receipt_id
  ), 0);
$$;


-- 可退款净额 = 已核销净额 - 未取消的退款合计（见设计要点 9）。
CREATE OR REPLACE FUNCTION ops.receipt_refundable (p_receipt_id uuid) returns numeric language sql stable security definer
SET
  search_path = '' AS $$
  select ops.receipt_allocated_net(p_receipt_id) - coalesce((
    select sum(refund.amount)
    from ops.refunds as refund
    where refund.receipt_id = p_receipt_id
      and refund.status <> 'cancelled'
  ), 0);
$$;


-- 收款状态机的合法动作（契约 §3.4）。三处共用：详情回包、非法迁移的
-- `allowedActions`、前端按钮。写成函数而不是在路由里写 switch，是因为
-- 「哪些边存在」这件事一旦有两份，前端就会出现「按钮亮着，点了 409」。
CREATE OR REPLACE FUNCTION ops.allowed_receipt_actions (p_status text) returns TEXT[] language sql immutable
SET
  search_path = '' AS $$
  select case p_status
    when 'recorded' then array['approve', 'reject', 'reverse']
    when 'pending_reconcile' then array['reconcile', 'reverse']
    when 'reconciled' then array['reconcile', 'reverse', 'refund']
    else array[]::text[]
  end;
$$;


CREATE OR REPLACE FUNCTION ops.operator_ref (p_operator_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select case
    when p_operator_id is null then null
    else (
      select jsonb_build_object(
        'id', operator.id,
        'display_name', coalesce(nullif(btrim(operator.display_name), ''), operator.email)
      )
      from ops.operators as operator
      where operator.id = p_operator_id
    )
  end;
$$;


CREATE OR REPLACE FUNCTION ops.receipt_json (p_receipt_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', entry.id,
    'receipt_no', entry.receipt_no,
    'customer_id', entry.customer_id,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name
    ),
    'contract_id', entry.contract_id,
    'contract_no', contract.contract_no,
    'transaction_date', entry.transaction_date,
    'amount', entry.amount,
    'currency', entry.currency,
    -- 收款方式的字典还没落地（U-19），label 先回落成 code：一个真实存在的
    -- 编码比一个编造的「银行转账」更安全。字典落地后只改这一行。
    'method', jsonb_build_object(
      'code', entry.method_code,
      'label', entry.method_code
    ),
    'reference_no', entry.reference_no,
    'voucher_ref', entry.voucher_ref,
    'status', entry.status,
    'allocated_amount', ops.receipt_allocated_net(entry.id),
    'refundable_amount', ops.receipt_refundable(entry.id),
    'recorded_by', ops.operator_ref(entry.recorded_by),
    'approved_by', ops.operator_ref(entry.approved_by),
    'approved_at', entry.approved_at,
    'recorded_reason', entry.recorded_reason,
    'version', entry.version,
    'created_at', entry.created_at,
    'updated_at', entry.updated_at
  )
  from ops.receipts as entry
  join ops.customers as customer on customer.id = entry.customer_id
  left join ops.contracts as contract on contract.id = entry.contract_id
  where entry.id = p_receipt_id;
$$;


CREATE OR REPLACE FUNCTION ops.refund_json (p_refund_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', entry.id,
    'refund_no', entry.refund_no,
    'receipt_id', entry.receipt_id,
    'receipt_no', receipt.receipt_no,
    'contract_id', entry.contract_id,
    'customer_id', entry.customer_id,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name
    ),
    'amount', entry.amount,
    'currency', entry.currency,
    'refund_date', entry.refund_date,
    'reason', entry.reason,
    'external_voucher_ref', entry.external_voucher_ref,
    'status', entry.status,
    'handled_by', ops.operator_ref(entry.handled_by),
    'approved_by', ops.operator_ref(entry.approved_by),
    'approved_at', entry.approved_at,
    'version', entry.version,
    'created_at', entry.created_at,
    'updated_at', entry.updated_at
  )
  from ops.refunds as entry
  join ops.receipts as receipt on receipt.id = entry.receipt_id
  join ops.customers as customer on customer.id = entry.customer_id
  where entry.id = p_refund_id;
$$;


-- ── 5. 收款列表 / 详情 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_receipts (
  p_customer_id uuid DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_method_code text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('receivable.read');

  with filtered as (
    select entry.*
    from ops.receipts as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (p_contract_id is null or entry.contract_id = p_contract_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
      and (p_method_code is null or entry.method_code = p_method_code)
      and (p_date_from is null or entry.transaction_date >= p_date_from)
      and (p_date_to is null or entry.transaction_date <= p_date_to)
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.transaction_date desc, filtered.receipt_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.receipt_json(page.id) order by
          filtered.transaction_date desc, filtered.receipt_no desc, filtered.id
        )
        from page
        join filtered on filtered.id = page.id
      ),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end;
$$;


-- 详情（契约 §5.5）。`reversals[]` 是**这张收款名下所有分配的**撤销流水，
-- 与 `GET /receivables/{id}` 的 `reversals[]` 口径不同：那边按应收过滤，
-- 这边按收款过滤。同一个词在两个端点指不同的集合，所以两边都在文档里写清楚。
CREATE OR REPLACE FUNCTION ops.get_receipt (p_receipt_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  allocations jsonb := '[]'::jsonb;
  reversals jsonb := '[]'::jsonb;
  refunds jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('receivable.read');

  if not exists (select 1 from ops.receipts as entry where entry.id = p_receipt_id) then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', allocation.id,
        'receivable_id', allocation.receivable_id,
        'period_no', receivable.period_no,
        'contract_id', receivable.contract_id,
        'due_date', receivable.due_date,
        'amount', allocation.amount,
        'reversed_amount', coalesce((
          select sum(reversal.amount)
          from ops.receipt_allocation_reversals as reversal
          where reversal.allocation_id = allocation.id
        ), 0),
        'allocated_by', ops.operator_ref(allocation.allocated_by),
        'allocated_at', allocation.allocated_at
      )
      order by allocation.allocated_at, allocation.id
    ),
    '[]'::jsonb
  )
  into allocations
  from ops.receipt_allocations as allocation
  join ops.receivables as receivable on receivable.id = allocation.receivable_id
  where allocation.receipt_id = p_receipt_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', reversal.id,
        'allocation_id', reversal.allocation_id,
        'receivable_id', allocation.receivable_id,
        'amount', reversal.amount,
        'reason', reversal.reason,
        'reversed_by', ops.operator_ref(reversal.reversed_by),
        'created_at', reversal.created_at
      )
      order by reversal.created_at, reversal.id
    ),
    '[]'::jsonb
  )
  into reversals
  from ops.receipt_allocation_reversals as reversal
  join ops.receipt_allocations as allocation on allocation.id = reversal.allocation_id
  where allocation.receipt_id = p_receipt_id;

  select coalesce(jsonb_agg(ops.refund_json(refund.id) order by refund.refund_date, refund.refund_no), '[]'::jsonb)
  into refunds
  from ops.refunds as refund
  where refund.receipt_id = p_receipt_id;

  return jsonb_build_object(
    'status', 'ok',
    'receipt', ops.receipt_json(p_receipt_id),
    'allocations', allocations,
    'reversals', reversals,
    'refunds', refunds
  );
end;
$$;


-- ── 6. 登记收款 ─────────────────────────────────────────────────────────────
--
-- `duplicate_warnings` 与 409 分开（契约 §5.5 同时要求两者）：
--   * **完全重复**（同客户 + 同流水号 + 同金额 + 同日期）→ `duplicate_reference`
--     → 409。这是同一笔钱被录了两遍，必须挡住。
--   * **仅流水号相同**（不同日期/金额/客户）→ 201 + `duplicate_warnings[]`。
--     银行流水号在不同银行、不同批次之间会重号，直接 403/409 会逼财务把真实
--     的第二笔钱改成假流水号才能入账。
CREATE OR REPLACE FUNCTION ops.record_receipt (
  p_customer_id uuid,
  p_contract_id uuid,
  p_transaction_date date,
  p_amount numeric,
  p_currency text,
  p_method_code text,
  p_reference_no text DEFAULT NULL,
  p_voucher_ref text DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  contract_row ops.contracts;
  new_id uuid;
  reference text := nullif(btrim(coalesce(p_reference_no, '')), '');
  warnings jsonb := '[]'::jsonb;
  currency_code char(3);
begin
  perform ops.require_permission('receipt.record');

  -- 金额校验先于一切查表：一条负数的请求不该先花三次 IO 才知道它非法。
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('status', 'amount_invalid');
  end if;

  -- 与应收计划同一条规矩：不接受静默四舍五入（见 billing 上半设计要点 7）。
  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('status', 'amount_scale_invalid');
  end if;

  if p_transaction_date is null then
    return jsonb_build_object('status', 'transaction_date_required');
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if p_method_code is null or length(btrim(p_method_code)) = 0 then
    return jsonb_build_object('status', 'method_required');
  end if;

  if p_currency is null or length(btrim(p_currency)) <> 3 then
    return jsonb_build_object('status', 'currency_invalid');
  end if;

  currency_code := upper(btrim(p_currency))::char(3);

  if not exists (select 1 from ops.customers as customer where customer.id = p_customer_id) then
    return jsonb_build_object('status', 'customer_not_found');
  end if;

  if p_contract_id is not null then
    select * into contract_row from ops.contracts as contract where contract.id = p_contract_id;

    if not found then
      return jsonb_build_object('status', 'contract_not_found');
    end if;

    if contract_row.customer_id <> p_customer_id then
      return jsonb_build_object(
        'status', 'customer_mismatch',
        'contract_customer_id', contract_row.customer_id
      );
    end if;

    if contract_row.currency <> currency_code then
      return jsonb_build_object(
        'status', 'currency_mismatch',
        'contract_currency', contract_row.currency
      );
    end if;
  end if;

  -- 完全重复：同客户 + 同流水号 + 同金额 + 同日期，且原记录没被冲正。
  -- 被冲正的那笔可以重录——它就是「上一笔作废了，重新记」。
  if reference is not null and exists (
    select 1
    from ops.receipts as existing
    where existing.customer_id = p_customer_id
      and existing.reference_no = reference
      and existing.amount = p_amount
      and existing.transaction_date = p_transaction_date
      and existing.status <> 'reversed'
  ) then
    return jsonb_build_object('status', 'duplicate_reference');
  end if;

  -- 仅流水号相同：给提示，不拦。
  if reference is not null then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'receipt_id', existing.id,
          'receipt_no', existing.receipt_no,
          'transaction_date', existing.transaction_date,
          'amount', existing.amount,
          'status', existing.status
        )
        order by existing.transaction_date desc, existing.receipt_no desc
      ),
      '[]'::jsonb
    )
    into warnings
    from ops.receipts as existing
    where existing.reference_no = reference
      and existing.customer_id = p_customer_id;
  end if;

  insert into ops.receipts (
    customer_id, contract_id, transaction_date, amount, currency,
    method_code, reference_no, voucher_ref, recorded_by, recorded_reason
  )
  values (
    p_customer_id,
    p_contract_id,
    p_transaction_date,
    p_amount::numeric(14, 2),
    currency_code,
    btrim(p_method_code),
    reference,
    nullif(btrim(coalesce(p_voucher_ref, '')), ''),
    actor_id,
    btrim(p_reason)
  )
  returning id into new_id;

  perform ops.write_audit(
    'receipt.recorded',
    'receipt',
    new_id,
    btrim(p_reason),
    null,
    jsonb_build_object(
      'receiptNo', (select receipt_no from ops.receipts where id = new_id),
      'customerId', p_customer_id,
      'contractId', p_contract_id,
      'amount', p_amount::numeric(14, 2),
      'currency', currency_code,
      'methodCode', btrim(p_method_code),
      'status', 'recorded'
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'receipt', ops.receipt_json(new_id),
    'duplicate_warnings', warnings
  );
end;
$$;


-- ── 7. 审核 / 驳回 ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.transition_receipt (
  p_receipt_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.receipts;
  next_status text;
  before_status text;
begin
  perform ops.require_permission('receipt.approve');

  select * into target
  from ops.receipts as entry
  where entry.id = p_receipt_id
  for update;

  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  if p_expected_version is not null and p_expected_version <> target.version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  before_status := target.status;

  if p_action = 'approve' then
    if target.status <> 'recorded' then
      return jsonb_build_object(
        'status', 'invalid_transition',
        'current_status', target.status,
        'allowed_actions', ops.allowed_receipt_actions(target.status)
      );
    end if;

    -- 职责分离。回一个独立状态而不是 409，因为这条不是「状态不允许」，是
    -- 「人不允许」——换成另一个人点同一个按钮就成功了（契约 §6.4 的 FORBIDDEN）。
    if target.recorded_by = actor_id then
      return jsonb_build_object('status', 'segregation_of_duty');
    end if;

    next_status := 'pending_reconcile';

    update ops.receipts
    set
      status = next_status,
      approved_by = actor_id,
      approved_at = now(),
      version = version + 1,
      updated_at = now()
    where id = p_receipt_id;

    perform ops.write_audit(
      'receipt.approved',
      'receipt',
      p_receipt_id,
      p_reason,
      jsonb_build_object('status', before_status),
      jsonb_build_object('status', next_status, 'approvedBy', actor_id)
    );
  elsif p_action = 'reject' then
    if target.status <> 'recorded' then
      return jsonb_build_object(
        'status', 'invalid_transition',
        'current_status', target.status,
        'allowed_actions', ops.allowed_receipt_actions(target.status)
      );
    end if;

    -- 驳回不删记录、不改状态（契约 §3.4「recorded（保留）」）。只把决定写进
    -- 审计与版本号：单据本身还是那条待审的单据，但「谁驳过、为什么」有据可查。
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('status', 'reason_required');
    end if;

    update ops.receipts
    set
      version = version + 1,
      updated_at = now()
    where id = p_receipt_id;

    perform ops.write_audit(
      'receipt.rejected',
      'receipt',
      p_receipt_id,
      btrim(p_reason),
      jsonb_build_object('status', before_status),
      jsonb_build_object('status', before_status, 'decision', 'rejected')
    );
  else
    return jsonb_build_object(
      'status', 'invalid_action',
      'allowed_actions', ops.allowed_receipt_actions(target.status)
    );
  end if;

  return jsonb_build_object('status', 'ok', 'receipt', ops.receipt_json(p_receipt_id));
end;
$$;


-- ── 8. 核销 ─────────────────────────────────────────────────────────────────
--
-- 契约 §3.4 的并发不变量，整段在一个函数里：锁收款 → 校验收款可分配额 →
-- 按 id 排序锁全部应收 → 逐期校验 → 更新余额 → 插流水 → 写审计。
--
-- 期间的任何一条失败都 `return`（不是 `raise`）：函数退出即语句结束，整个事务
-- 由调用方（PostgREST 的单个请求）回滚，已插入的行不会留下。这也是本域所有
-- 失败分支都用信封而不是异常的原因——异常会把「为什么失败」压成一句 SQL 错误。
CREATE OR REPLACE FUNCTION ops.allocate_receipt (
  p_receipt_id uuid,
  p_allocations jsonb DEFAULT '[]'::jsonb,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.receipts;
  entry jsonb;
  entry_index integer;
  entry_amount numeric;
  entry_receivable_id uuid;
  requested_total numeric := 0;
  allocatable numeric;
  target_ids uuid[] := '{}';
  locked_count integer := 0;
  receivable_row ops.receivables;
  before_status text;
  touched uuid[] := '{}';
begin
  perform ops.require_permission('receipt.reconcile');

  select * into target
  from ops.receipts as entry_row
  where entry_row.id = p_receipt_id
  for update;

  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  -- 未审核不得核销（契约 §5.5 的 403 → 409 RECEIPT_NOT_APPROVED）。
  -- 这里回 409 而不是 403：调用者有 `receipt.reconcile` 权限，被挡的原因是
  -- 单据状态，换成「先去审核」就通了。
  if target.status = 'recorded' then
    return jsonb_build_object(
      'status', 'receipt_not_approved',
      'allowed_actions', ops.allowed_receipt_actions(target.status)
    );
  end if;

  if target.status not in ('pending_reconcile', 'reconciled') then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', target.status,
      'allowed_actions', ops.allowed_receipt_actions(target.status)
    );
  end if;

  if p_allocations is null or jsonb_typeof(p_allocations) <> 'array'
    or jsonb_array_length(p_allocations) = 0
  then
    return jsonb_build_object('status', 'allocations_required');
  end if;

  -- 第一趟：只校验入站形状，累计本次合计。不查表，先把「这不是一笔合法请求」
  -- 的情况全部挡在加锁之前。
  for entry, entry_index in
    select element.value, element.ordinality
    from jsonb_array_elements(p_allocations) with ordinality as element (value, ordinality)
  loop
    begin
      entry_receivable_id := (entry ->> 'receivableId')::uuid;
      entry_amount := (entry ->> 'amount')::numeric;
    exception
      when others then
        return jsonb_build_object('status', 'allocation_invalid', 'index', entry_index);
    end;

    if entry_receivable_id is null then
      return jsonb_build_object('status', 'allocation_invalid', 'index', entry_index);
    end if;

    if entry_amount is null or entry_amount <= 0 then
      return jsonb_build_object('status', 'allocation_invalid', 'index', entry_index);
    end if;

    if entry_amount <> round(entry_amount, 2) then
      return jsonb_build_object(
        'status', 'amount_scale_invalid',
        'index', entry_index
      );
    end if;

    -- 同一期出现两次会让「每期余额」的校验各自通过、合计却超额：
    -- 1000 的期收两笔 600，每笔单独看都 <= 1000。
    if entry_receivable_id = any (target_ids) then
      return jsonb_build_object(
        'status', 'duplicate_receivable',
        'index', entry_index,
        'receivable_id', entry_receivable_id
      );
    end if;

    target_ids := array_append(target_ids, entry_receivable_id);
    requested_total := requested_total + entry_amount;
  end loop;

  allocatable := target.amount - ops.receipt_allocated_net(p_receipt_id);

  if requested_total > allocatable then
    return jsonb_build_object(
      'status', 'receipt_exceeded',
      'requested_total', requested_total,
      'allocatable', allocatable
    );
  end if;

  -- 按 id 排序加锁（见设计要点 3）。`order by` 放在 `for update` 之前才有效。
  with locked as (
    select receivable.id
    from ops.receivables as receivable
    where receivable.id = any (target_ids)
    order by receivable.id
    for update
  )
  select count(*) into locked_count from locked;

  if locked_count <> cardinality(target_ids) then
    -- 有 id 不存在。不再细分是哪一个：调用方拿到 404 后自己核对入参，
    -- 而「第几条错了」在 response 里由 index 给出更直接。
    return jsonb_build_object('status', 'receivable_not_found');
  end if;

  before_status := target.status;

  -- 第二趟：逐期校验 + 落库。已加锁，读到的余额不会再被并发改动。
  for entry, entry_index in
    select element.value, element.ordinality
    from jsonb_array_elements(p_allocations) with ordinality as element (value, ordinality)
  loop
    entry_receivable_id := (entry ->> 'receivableId')::uuid;
    entry_amount := (entry ->> 'amount')::numeric;

    select * into receivable_row
    from ops.receivables as receivable
    where receivable.id = entry_receivable_id;

    if receivable_row.customer_id <> target.customer_id then
      return jsonb_build_object(
        'status', 'customer_mismatch',
        'index', entry_index,
        'receivable_id', entry_receivable_id
      );
    end if;

    if receivable_row.currency <> target.currency then
      return jsonb_build_object(
        'status', 'currency_mismatch',
        'index', entry_index,
        'receivable_id', entry_receivable_id,
        'receivable_currency', receivable_row.currency
      );
    end if;

    -- 每期余额：`net + 本次 <= amount`。写成 net 而不是
    -- `allocated + 本次 <= amount + reversed`，是因为后者在 reversed 非零时
    -- 会放过「本期实际超额」的情况——reversed 是历史撤销额，不是可用额度。
    if (receivable_row.allocated_amount - receivable_row.reversed_amount) + entry_amount > receivable_row.amount then
      return jsonb_build_object(
        'status', 'receivable_exceeded',
        'index', entry_index,
        'receivable_id', entry_receivable_id,
        'outstanding', receivable_row.amount - (receivable_row.allocated_amount - receivable_row.reversed_amount)
      );
    end if;

    insert into ops.receipt_allocations (
      receipt_id, receivable_id, amount, customer_id, currency, allocated_by
    )
    values (
      p_receipt_id,
      entry_receivable_id,
      entry_amount::numeric(14, 2),
      target.customer_id,
      target.currency,
      actor_id
    );

    update ops.receivables
    set
      allocated_amount = allocated_amount + entry_amount,
      version = version + 1,
      updated_by = actor_id,
      updated_at = now()
    where id = entry_receivable_id;

    touched := array_append(touched, entry_receivable_id);
  end loop;

  update ops.receipts
  set
    status = 'reconciled',
    version = version + 1,
    updated_at = now()
  where id = p_receipt_id;

  perform ops.write_audit(
    'receipt.reconciled',
    'receipt',
    p_receipt_id,
    p_reason,
    jsonb_build_object('status', before_status),
    jsonb_build_object(
      'status', 'reconciled',
      'allocatedTotal', requested_total,
      'receivableIds', to_jsonb(touched)
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'receipt', ops.receipt_json(p_receipt_id),
    'receivables_summary', (
      select coalesce(
        jsonb_agg(ops.receivable_json(receivable.id) order by receivable.period_no),
        '[]'::jsonb
      )
      from ops.receivables as receivable
      where receivable.id = any (touched)
    )
  );
end;
$$;


-- ── 9. 冲正收款 ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.reverse_receipt (
  p_receipt_id uuid,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.receipts;
  net numeric;
  before_status text;
begin
  perform ops.require_permission('receipt.reverse');

  select * into target
  from ops.receipts as entry
  where entry.id = p_receipt_id
  for update;

  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  if p_expected_version is not null and p_expected_version <> target.version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if target.status = 'reversed' then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', target.status,
      'allowed_actions', ops.allowed_receipt_actions(target.status)
    );
  end if;

  -- 有有效核销时必须先撤销核销（契约 §6.4 HAS_ALLOCATIONS）。判净额而不是
  -- 「有没有分配行」：一条已被全额撤销的分配，账上等于没核销过，不该继续挡路。
  net := ops.receipt_allocated_net(p_receipt_id);

  if net > 0 then
    return jsonb_build_object('status', 'has_allocations', 'allocated_amount', net);
  end if;

  before_status := target.status;

  update ops.receipts
  set
    status = 'reversed',
    version = version + 1,
    updated_at = now()
  where id = p_receipt_id;

  perform ops.write_audit(
    'receipt.reversed',
    'receipt',
    p_receipt_id,
    btrim(p_reason),
    jsonb_build_object('status', before_status),
    jsonb_build_object('status', 'reversed', 'amount', target.amount)
  );

  return jsonb_build_object(
    'status', 'ok',
    'receipt', ops.receipt_json(p_receipt_id),
    'reversal', jsonb_build_object('amount', target.amount)
  );
end;
$$;


-- ── 10. 撤销核销 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.reverse_allocation (
  p_allocation_id uuid,
  p_amount numeric DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  allocation_row ops.receipt_allocations;
  receipt_row ops.receipts;
  receivable_row ops.receivables;
  already_reversed numeric;
  reversal_amount numeric;
  reversal_id uuid;
begin
  perform ops.require_permission('receipt.reverse');

  select * into allocation_row
  from ops.receipt_allocations as entry
  where entry.id = p_allocation_id
  for update;

  if not found then
    return jsonb_build_object('status', 'allocation_not_found');
  end if;

  -- 锁收款：撤销会让收款的已核销净额变化，进而影响它的可分配额与可退额。
  -- 不锁的话，一次「撤销核销」与一次「新核销」并发时，两边都以为自己看到的是
  -- 最终余额。锁的顺序与 allocate_receipt 一致（先收款、后应收），避免死锁。
  select * into receipt_row
  from ops.receipts as entry
  where entry.id = allocation_row.receipt_id
  for update;

  select * into receivable_row
  from ops.receivables as entry
  where entry.id = allocation_row.receivable_id
  for update;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  select coalesce(sum(reversal.amount), 0) into already_reversed
  from ops.receipt_allocation_reversals as reversal
  where reversal.allocation_id = p_allocation_id;

  -- 不传金额 = 全额撤销；传了就按传入的算。两种都受「不超过可撤销额」约束。
  reversal_amount := coalesce(p_amount, allocation_row.amount - already_reversed);

  if reversal_amount is null or reversal_amount <= 0 then
    return jsonb_build_object(
      'status', 'amount_invalid',
      'reversible', allocation_row.amount - already_reversed
    );
  end if;

  if reversal_amount <> round(reversal_amount, 2) then
    return jsonb_build_object('status', 'amount_scale_invalid');
  end if;

  if reversal_amount > allocation_row.amount - already_reversed then
    return jsonb_build_object(
      'status', 'reversal_exceeded',
      'reversible', allocation_row.amount - already_reversed
    );
  end if;

  insert into ops.receipt_allocation_reversals (allocation_id, amount, reason, reversed_by)
  values (p_allocation_id, reversal_amount::numeric(14, 2), btrim(p_reason), actor_id)
  returning id into reversal_id;

  update ops.receivables
  set
    reversed_amount = reversed_amount + reversal_amount,
    version = version + 1,
    updated_by = actor_id,
    updated_at = now()
  where id = allocation_row.receivable_id;

  -- 收款状态在这里**不动**。契约 §3.4 的状态机只有 `reverse` 一条边能到
  -- `reversed`，核销撤销是子资源动作，没有回到 `pending_reconcile` 的边。
  -- 「核销全撤销了但收款仍显示已核销」这个不一致已登记为 C-111。

  perform ops.write_audit(
    'receipt.allocation_reversed',
    'receipt_allocation',
    p_allocation_id,
    btrim(p_reason),
    jsonb_build_object(
      'allocationAmount', allocation_row.amount,
      'reversedAmount', already_reversed
    ),
    jsonb_build_object(
      'reversedAmount', already_reversed + reversal_amount,
      'receiptId', allocation_row.receipt_id,
      'receivableId', allocation_row.receivable_id
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'allocation', jsonb_build_object(
      'id', p_allocation_id,
      'amount', allocation_row.amount,
      'reversed_amount', already_reversed + reversal_amount
    ),
    'receivable', ops.receivable_json(allocation_row.receivable_id),
    'receipt', ops.receipt_json(allocation_row.receipt_id)
  );
end;
$$;


-- ── 11. 退款 ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_refunds (
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('receivable.read');

  with filtered as (
    select entry.*
    from ops.refunds as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
      and (p_date_from is null or entry.refund_date >= p_date_from)
      and (p_date_to is null or entry.refund_date <= p_date_to)
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.refund_date desc, filtered.refund_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.refund_json(page.id) order by
          filtered.refund_date desc, filtered.refund_no desc, filtered.id
        )
        from page
        join filtered on filtered.id = page.id
      ),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end;
$$;


CREATE OR REPLACE FUNCTION ops.record_refund (
  p_receipt_id uuid,
  p_amount numeric,
  p_refund_date date,
  p_reason text,
  p_external_voucher_ref text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  receipt_row ops.receipts;
  refundable numeric;
  new_id uuid;
begin
  perform ops.require_permission('receipt.refund');

  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('status', 'amount_invalid');
  end if;

  if p_amount <> round(p_amount, 2) then
    return jsonb_build_object('status', 'amount_scale_invalid');
  end if;

  if p_refund_date is null then
    return jsonb_build_object('status', 'refund_date_required');
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  select * into receipt_row
  from ops.receipts as entry
  where entry.id = p_receipt_id
  for update;

  if not found then
    return jsonb_build_object('status', 'receipt_not_found');
  end if;

  -- 可退额来自「已核销净额 - 未取消的退款」（见设计要点 9）。收款被冲正后
  -- 核销净额为 0，可退额自然也是 0，不需要再判状态。
  refundable := ops.receipt_refundable(p_receipt_id);

  if p_amount > refundable then
    return jsonb_build_object(
      'status', 'refund_exceeded',
      'requested_amount', p_amount,
      'refundable', refundable
    );
  end if;

  insert into ops.refunds (
    receipt_id, contract_id, customer_id, amount, currency, refund_date,
    reason, external_voucher_ref, handled_by
  )
  values (
    p_receipt_id,
    receipt_row.contract_id,
    receipt_row.customer_id,
    p_amount::numeric(14, 2),
    receipt_row.currency,
    p_refund_date,
    btrim(p_reason),
    nullif(btrim(coalesce(p_external_voucher_ref, '')), ''),
    actor_id
  )
  returning id into new_id;

  perform ops.write_audit(
    'refund.recorded',
    'refund',
    new_id,
    btrim(p_reason),
    null,
    jsonb_build_object(
      'refundNo', (select refund_no from ops.refunds where id = new_id),
      'receiptId', p_receipt_id,
      'amount', p_amount::numeric(14, 2),
      'currency', receipt_row.currency,
      'status', 'recorded'
    )
  );

  return jsonb_build_object('status', 'ok', 'refund', ops.refund_json(new_id));
end;
$$;


-- 退款的审核 / 取消。
--
-- 审核通过后要判一次「是否退满」：契约 §3.4 的收款状态机有一条
-- `reconciled → refunded`（累计已审核退款额 = 收款额）。这条边由**最后一次
-- 退款审核**触发，没有独立端点——所以它必须在这里判，漏了就永远到不了
-- `refunded`，而「已退款」这个筛选条件会一直返回空。
CREATE OR REPLACE FUNCTION ops.transition_refund (
  p_refund_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.refunds;
  receipt_row ops.receipts;
  approved_total numeric;
  next_status text;
begin
  perform ops.require_permission('receipt.refund');

  select * into target
  from ops.refunds as entry
  where entry.id = p_refund_id
  for update;

  if not found then
    return jsonb_build_object('status', 'refund_not_found');
  end if;

  if p_action is null or p_action not in ('approve', 'cancel') then
    return jsonb_build_object(
      'status', 'invalid_action',
      'allowed_actions', array['approve', 'cancel']
    );
  end if;

  if target.status <> 'recorded' then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', target.status,
      'allowed_actions', case
        when target.status = 'recorded' then array['approve', 'cancel']
        else array[]::text[]
      end
    );
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if p_action = 'cancel' then
    update ops.refunds
    set
      status = 'cancelled',
      version = version + 1,
      updated_at = now()
    where id = p_refund_id;

    perform ops.write_audit(
      'refund.cancelled',
      'refund',
      p_refund_id,
      btrim(p_reason),
      jsonb_build_object('status', target.status),
      jsonb_build_object('status', 'cancelled')
    );

    return jsonb_build_object(
      'status', 'ok',
      'refund', ops.refund_json(p_refund_id),
      'receipt', ops.receipt_json(target.receipt_id)
    );
  end if;

  update ops.refunds
  set
    status = 'approved',
    approved_by = actor_id,
    approved_at = now(),
    version = version + 1,
    updated_at = now()
  where id = p_refund_id;

  select * into receipt_row
  from ops.receipts as entry
  where entry.id = target.receipt_id
  for update;

  select coalesce(sum(refund.amount), 0) into approved_total
  from ops.refunds as refund
  where refund.receipt_id = target.receipt_id
    and refund.status = 'approved';

  if receipt_row.status = 'reconciled' and approved_total = receipt_row.amount then
    update ops.receipts
    set
      status = 'refunded',
      version = version + 1,
      updated_at = now()
    where id = target.receipt_id;
  end if;

  perform ops.write_audit(
    'refund.approved',
    'refund',
    p_refund_id,
    btrim(p_reason),
    jsonb_build_object('status', target.status),
    jsonb_build_object(
      'status', 'approved',
      'approvedTotal', approved_total,
      'receiptStatus', (select status from ops.receipts where id = target.receipt_id)
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'refund', ops.refund_json(p_refund_id),
    'receipt', ops.receipt_json(target.receipt_id)
  );
end;
$$;


-- ── 12. 授权 ────────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE ops.receipts,
ops.receipt_allocations,
ops.receipt_allocation_reversals,
ops.refunds
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.receipts ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.receipt_allocations ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.receipt_allocation_reversals ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.refunds ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON SEQUENCE ops.receipt_no_seq,
ops.refund_no_seq
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.receipt_allocated_net (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.receipt_refundable (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allowed_receipt_actions (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.operator_ref (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.receipt_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.refund_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_receipts (
  uuid,
  uuid,
  TEXT[],
  text,
  date,
  date,
  integer,
  integer
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_receipt (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.record_receipt (
  uuid,
  uuid,
  date,
  numeric,
  text,
  text,
  text,
  text,
  text
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.transition_receipt (uuid, text, text, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allocate_receipt (uuid, jsonb, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.reverse_receipt (uuid, text, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.reverse_allocation (uuid, numeric, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_refunds (uuid, TEXT[], date, date, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.record_refund (uuid, numeric, date, text, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.transition_refund (uuid, text, text)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.list_receipts (
  uuid,
  uuid,
  TEXT[],
  text,
  date,
  date,
  integer,
  integer
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_receipt (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.record_receipt (
  uuid,
  uuid,
  date,
  numeric,
  text,
  text,
  text,
  text,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_receipt (uuid, text, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.allocate_receipt (uuid, jsonb, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.reverse_receipt (uuid, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.reverse_allocation (uuid, numeric, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_refunds (uuid, TEXT[], date, date, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.record_refund (uuid, numeric, date, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_refund (uuid, text, text) TO authenticated,
service_role;


COMMENT ON TABLE ops.receipts IS '收款登记（契约 §3.4）。线下事实登记，不调支付渠道；状态机五态；登记人≠审核人由 CHECK 兜底。';


COMMENT ON TABLE ops.receipt_allocations IS '核销分配，仅 INSERT。复合外键让跨客户/跨币种核销在数据库层无法成立。';


COMMENT ON TABLE ops.receipt_allocation_reversals IS '核销撤销，仅 INSERT 的反向流水。不改原分配行，撤销额累加到 receivables.reversed_amount。';


COMMENT ON TABLE ops.refunds IS '退款登记（契约 §3.4）。不调渠道发起退款，只记事实；累计退款 ≤ 收款已核销净额。';


COMMENT ON function ops.receipt_allocated_net (uuid) IS '收款的已核销净额（分配合计 - 撤销合计）。列表、核销可分配额、退款可退额、冲正守卫四处共用。';


COMMENT ON function ops.receipt_refundable (uuid) IS '可退款净额 = 已核销净额 - 未取消的退款合计。未审核收款的可退额自然为 0。';


COMMENT ON function ops.allowed_receipt_actions (text) IS '收款状态机的合法动作（契约 §3.4）。详情回包、非法迁移、前端按钮三处共用。';


COMMENT ON function ops.record_receipt (
  uuid,
  uuid,
  date,
  numeric,
  text,
  text,
  text,
  text,
  text
) IS '登记收款。完全重复（同客户+同流水号+同金额+同日期）回 duplicate_reference（409），仅流水号相同回 duplicate_warnings；两者分开是因为银行流水号会重号。';


COMMENT ON function ops.allocate_receipt (uuid, jsonb, text) IS '核销：锁收款 → 校验可分配额 → 按 id 排序锁全部应收 → 逐期校验 → 更新余额 + 插流水 + 写审计，同事务。';


COMMENT ON function ops.reverse_allocation (uuid, numeric, text) IS '撤销核销：写反向流水并累加 receivables.reversed_amount，不回退 allocated_amount，不改收款状态（C-111）。';


COMMENT ON function ops.transition_refund (uuid, text, text) IS '退款审核/取消。审核通过后若累计已审核退款额等于收款额，把收款迁到 refunded——没有独立端点触发这条边。';