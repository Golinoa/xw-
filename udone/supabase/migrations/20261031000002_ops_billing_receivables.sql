-- 运营 billing 域（上半）：两张表 + 七个函数 + 四个端点对应 RPC（契约 §3.4、§5.5）。
--
-- 本域只做「应收计划与展期」（T-07）。收款、核销、退款（`receipts`、
-- `receipt_allocations`、`receipt_allocation_reversals`、`refunds`）属 T-08，
-- 本轮不存在——`GET /receivables/{id}` 的 `allocations[]` / `reversals[]` 用
-- `to_regclass` 守卫返回空数组，与合同域处理未落地域的办法一致。
--
-- 设计要点：
--
-- 1. **应收状态不落库，由函数算。** 契约 §3.4 明确「派生值，不落库」，理由是
--    逾期会随时间自己发生：落库就必须有一个定时任务去刷 `status`，而任务没跑
--    或跑错的那段时间里，列表、总览、报表会各说一套。函数只有一份
--    （`ops.receivable_status`），列表筛选、详情、合同详情里的摘要都调它，
--    「图表与列表同一口径」才成立。
--
-- 2. **「今天」按 Asia/Shanghai 算，不用 `current_date`。** 服务器在 UTC 时，
--    北京时间 00:00–08:00 的 `current_date` 还是前一天，逾期判定会整体晚一天。
--    契约 §2 把这条写成硬约束（[推导]），这里落成 `ops.receivable_today()`，
--    不散落在各函数里写 `(now() at time zone ...)`——散写迟早有一处漏。
--
-- 3. **计划合计必须等于合同金额，一分不差。** 契约 §5.5 的 400
--    `details.reason='PLAN_TOTAL_MISMATCH'`。不做「差额自动补到最后一期」：
--    那会让「合同 12 万、计划合计 11.9 万」这种录入错误悄悄变成一张尾差计划，
--    等到对账才发现少收了一千。返回 `planned_total` 与 `contract_total` 两个数，
--    前端才能说清差多少。
--
-- 4. **展期只允许未结清应收。** 已结清（`net >= amount`）展期没有意义，且会让
--    「按期收款率」这类报表把一笔已收的钱重新算成未来应收。返回
--    `receivable_settled`，路由映射 409 + `RECEIVABLE_SETTLED`（§6.4 词表）。
--    新到期日必须**严格晚于**当前到期日：同日「展期」是改备注，不是展期。
--
-- 5. **展期保留原到期日。** `receivable_extensions` 记 `previous_due_date`，
--    只 INSERT 不改不删。`receivables.due_date` 被覆盖成新日期——所以「历史
--    到期日」只能从这张表读回来，这也正是契约要求「追加展期记录」的原因。
--
-- 6. **`version` 是乐观锁。** 展期请求必须带 `version`，不符返回
--    `version_mismatch` 并带 `current_version`：两个人同时展期同一期，后到的
--    那个必须看见冲突，而不是把前一个人的新日期覆盖掉（覆盖后两次展期只留一条
--    记录，审计上看起来只展期了一次）。
--
-- 7. **金额比较用 numeric，不用浮点。** `sum(amount) = contract.total_amount`
--    是精确比较，两位小数；入站金额先按 `round(x, 2)` 判「是否多于两位小数」，
--    多出来的直接 `amount_scale_invalid`，不静默四舍五入——静默舍入会让计划
--    合计与合同金额差几分钱，而这条错误最难查。
CREATE TABLE ops.receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  period_no integer NOT NULL CHECK (period_no >= 1),
  due_date date NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'CNY',
  allocated_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (allocated_amount BETWEEN 0 AND amount),
  -- 撤销额单独一列，不直接减 allocated：撤销是「反向流水」，核销记录本身要保留，
  -- 否则「这笔钱核销过又被撤销」这件事在数据里就消失了。
  reversed_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (reversed_amount BETWEEN 0 AND amount),
  note text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 一合同内期号唯一：同一份合同不能有两期「第 3 期」。
  UNIQUE (contract_id, period_no),
  -- 复合外键的落点：T-08 的 `receipt_allocations` 用它保证「跨客户/跨币种核销
  -- 在数据库层无法成立」。单列 id 已是主键，这个唯一键只为被引用而存在。
  UNIQUE (id, customer_id, currency)
);


CREATE INDEX receivables_due_idx ON ops.receivables (due_date, currency);


CREATE INDEX receivables_customer_due_idx ON ops.receivables (customer_id, due_date);


CREATE INDEX receivables_contract_idx ON ops.receivables (contract_id);


CREATE TABLE ops.receivable_extensions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receivable_id uuid NOT NULL REFERENCES ops.receivables (id) ON DELETE RESTRICT,
  previous_due_date date NOT NULL,
  new_due_date date NOT NULL,
  -- 空字符串不算写了原因：展期是「为什么晚收」的唯一书面依据。
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (new_due_date > previous_due_date)
);


CREATE INDEX receivable_extensions_receivable_idx ON ops.receivable_extensions (receivable_id, created_at);


-- 业务时区的「今天」。单点定义，避免三个函数的判定口径漂移。
--
-- `stable` 而不是 `immutable`：同一天内结果不变，但跨天会变；标成 immutable
-- 会让计划缓存把「今天」固定成建计划那天。
CREATE OR REPLACE FUNCTION ops.receivable_today () returns date language sql stable
SET
  search_path = '' AS $$
  select (now() at time zone 'Asia/Shanghai')::date;
$$;


-- 应收状态派生（契约 §3.4 的五档，优先级从高到低）。
--
-- 入参全部显式传入、不查表：这样它可以在列表、详情、聚合摘要三处复用，
-- 也可以在 pgTAP 里直接对着边界值断言，不需要先造数据。
--
-- `net = allocated - reversed`；`reversed` 是「归属于该期的撤销额」。
-- `unpaid` 是契约保留值，v1 不返回（U-02：语义与 overdue 重叠）。
CREATE OR REPLACE FUNCTION ops.receivable_status (
  p_amount numeric,
  p_allocated numeric,
  p_reversed numeric,
  p_due_date date,
  p_today date
) returns text language sql immutable
SET
  search_path = '' AS $$
  select case
    -- 1. 撤销额把那期的核销吃干净了：钱退回去了，这期重新变成没收。
    when p_reversed > 0 and (p_allocated - p_reversed) <= 0 then 'reversed'
    -- 2. 收满。注意 `>=`：超额核销在 T-08 会被挡，但历史数据或人工修数可能留
    --    下超额值，`>=` 让这类行仍显示为已收满，而不是掉进 overdue。
    when (p_allocated - p_reversed) >= p_amount then 'paid'
    -- 3. 到期未收满。走到这里 net < amount 已成立，无需再判。
    when p_due_date < p_today then 'overdue'
    -- 4. 收了一部分且未到期。
    when (p_allocated - p_reversed) > 0 then 'partial'
    -- 5. 一分未收且未到期。
    else 'upcoming'
  end;
$$;


-- 单条应收的出站形状（snake_case，出站由 protocol.ts 转 camelCase）。
--
-- 带 `contract_no` 与客户摘要，是因为列表要直接渲染「哪份合同、哪个客户」——
-- 只回 id 会逼前端为每行再查一次，把一次列表变成 N+1（与 U-20 同一个理由）。
CREATE OR REPLACE FUNCTION ops.receivable_json (p_receivable_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', entry.id,
    'contract_id', entry.contract_id,
    'contract_no', contract.contract_no,
    'customer_id', entry.customer_id,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name
    ),
    'period_no', entry.period_no,
    'due_date', entry.due_date,
    'amount', entry.amount,
    'currency', entry.currency,
    'allocated_amount', entry.allocated_amount,
    'reversed_amount', entry.reversed_amount,
    'outstanding', entry.amount - (entry.allocated_amount - entry.reversed_amount),
    'status', ops.receivable_status(
      entry.amount,
      entry.allocated_amount,
      entry.reversed_amount,
      entry.due_date,
      ops.receivable_today()
    ),
    'note', entry.note,
    'version', entry.version,
    'created_at', entry.created_at,
    'updated_at', entry.updated_at
  )
  from ops.receivables as entry
  join ops.contracts as contract on contract.id = entry.contract_id
  join ops.customers as customer on customer.id = entry.customer_id
  where entry.id = p_receivable_id;
$$;


-- 列表 + 汇总（契约 §5.5 第一条）。
--
-- 排序表达式出现两次（分页子查询里一次，`jsonb_agg` 里一次）是刻意的：
-- `jsonb_agg` 不继承子查询的物理顺序，而 window 函数又要再写一遍同样的表达式。
-- 与其拼动态 SQL（本项目只在 `to_regclass` 场景用动态 SQL），不如接受这段重复——
-- 白名单只有 dueDate / amount 两个值，`CASE` 比字符串拼接更不容易被注入。
CREATE OR REPLACE FUNCTION ops.list_receivables (
  p_customer_id uuid DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_due_from date DEFAULT NULL,
  p_due_to date DEFAULT NULL,
  p_overdue_only boolean DEFAULT FALSE,
  p_sort text DEFAULT 'due_date',
  p_sort_desc boolean DEFAULT FALSE,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  today_date date := ops.receivable_today();
  result jsonb;
begin
  perform ops.require_permission('receivable.read');

  with scoped as (
    select
      entry.*,
      ops.receivable_status(
        entry.amount, entry.allocated_amount, entry.reversed_amount,
        entry.due_date, today_date
      ) as status
    from ops.receivables as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (p_contract_id is null or entry.contract_id = p_contract_id)
      and (p_due_from is null or entry.due_date >= p_due_from)
      and (p_due_to is null or entry.due_date <= p_due_to)
  ),
  filtered as (
    select scoped.*
    from scoped
    where (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or scoped.status = any (p_statuses)
      )
      and (not coalesce(p_overdue_only, false) or scoped.status = 'overdue')
  ),
  page as (
    select filtered.id
    from filtered
    order by
      case when p_sort = 'due_date' and not p_sort_desc then filtered.due_date end asc nulls last,
      case when p_sort = 'due_date' and p_sort_desc then filtered.due_date end desc nulls last,
      case when p_sort = 'amount' and not p_sort_desc then filtered.amount end asc nulls last,
      case when p_sort = 'amount' and p_sort_desc then filtered.amount end desc nulls last,
      filtered.period_no asc,
      filtered.id asc
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    -- `total` 是筛选后的总条数，与分页无关；前端用它算页数。
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.receivable_json(page.id) order by
          case when p_sort = 'due_date' and not p_sort_desc then filtered.due_date end asc nulls last,
          case when p_sort = 'due_date' and p_sort_desc then filtered.due_date end desc nulls last,
          case when p_sort = 'amount' and not p_sort_desc then filtered.amount end asc nulls last,
          case when p_sort = 'amount' and p_sort_desc then filtered.amount end desc nulls last,
          filtered.period_no asc,
          filtered.id asc
        )
        from page
        join filtered on filtered.id = page.id
      ),
      '[]'::jsonb
    ),
    -- 汇总基于筛选后的全量，不是当前页：翻页时合计不该跳。
    --
    -- `settled + outstanding = total` 必须恒成立，否则前端两处数字对不上，
    -- 而这类「合计不等于分项之和」的缺陷最容易被当成四舍五入放过。
    -- 所以 settled 取「全量的核销净额」（不只是 paid 期的），outstanding 取
    -- 「全量的未收余额」——两式互补，与状态无关；overdue 只是 outstanding
    -- 里逾期那一块，是子集而不再是另一种算法。
    'summary', jsonb_build_object(
      'total_amount', coalesce((select sum(filtered.amount) from filtered), 0),
      'settled_amount', coalesce((
        select sum(filtered.allocated_amount - filtered.reversed_amount)
        from filtered
      ), 0),
      'outstanding_amount', coalesce((
        select sum(filtered.amount - (filtered.allocated_amount - filtered.reversed_amount))
        from filtered
      ), 0),
      'overdue_amount', coalesce((
        select sum(filtered.amount - (filtered.allocated_amount - filtered.reversed_amount))
        from filtered where filtered.status = 'overdue'
      ), 0)
    )
  )
  into result;

  return result;
end;
$$;


-- 详情（契约 §5.5 第三条）。
--
-- `allocations[]` / `reversals[]` 指向 T-08 才落地的表：不存在时返回空数组，
-- 而不是省略键（前端按 `.length` 渲染，缺键在运行期抛 TypeError）。
CREATE OR REPLACE FUNCTION ops.get_receivable (p_receivable_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  extensions jsonb := '[]'::jsonb;
  allocations jsonb := '[]'::jsonb;
  reversals jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('receivable.read');

  if not exists (
    select 1 from ops.receivables as entry where entry.id = p_receivable_id
  ) then
    return jsonb_build_object('status', 'receivable_not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', extension.id,
        'previous_due_date', extension.previous_due_date,
        'new_due_date', extension.new_due_date,
        'reason', extension.reason,
        'created_by', extension.created_by,
        'created_at', extension.created_at
      )
      order by extension.created_at desc, extension.id
    ),
    '[]'::jsonb
  )
  into extensions
  from ops.receivable_extensions as extension
  where extension.receivable_id = p_receivable_id;

  -- T-08 落地后这两段自动开始返回原始行，不需要改本函数。
  if to_regclass('ops.receipt_allocations') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry) order by entry.allocated_at, entry.id), '[]'::jsonb)
      from ops.receipt_allocations as entry
      where entry.receivable_id = $1
    $sql$ into allocations using p_receivable_id;
  end if;

  if to_regclass('ops.receipt_allocation_reversals') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry) order by entry.created_at, entry.id), '[]'::jsonb)
      from ops.receipt_allocation_reversals as entry
      join ops.receipt_allocations as allocation on allocation.id = entry.allocation_id
      where allocation.receivable_id = $1
    $sql$ into reversals using p_receivable_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'receivable', ops.receivable_json(p_receivable_id),
    'allocations', allocations,
    'extensions', extensions,
    'reversals', reversals
  );
end;
$$;


-- 生成应收计划（契约 §5.5 第二条）。
--
-- 一次请求写整份计划，不提供「单期新增/删除」：计划的语义是「这份合同的收款
-- 安排」，分期生成后再单删一期，合计就与合同金额对不上了，而 `PLAN_TOTAL_MISMATCH`
-- 只在生成时校验得到。要改就是重新生成（`plan_exists` 会挡住，需先由合同变更
-- 流程处理），这样「计划合计 = 合同金额」这条不变量在任何时刻都成立。
CREATE OR REPLACE FUNCTION ops.create_receivable_plan (
  p_contract_id uuid,
  p_periods jsonb DEFAULT '[]'::jsonb
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  contract_row ops.contracts;
  entry jsonb;
  entry_index integer;
  entry_due date;
  -- 刻意**不带精度**：`numeric(14,2)` 的变量在赋值时就会把 6000.005 舍成
  -- 6000.01，于是「多于两位小数」的校验永远看不到原始值，静默舍入恰好绕过
  -- 那道闸。声明成无边界的 numeric，校验才真的在看入站数字。
  entry_amount numeric;
  planned_total numeric(14, 2) := 0;
  created_ids uuid[] := '{}';
  created_id uuid;
begin
  perform ops.require_permission('receivable.write');

  select * into contract_row from ops.contracts as contract where contract.id = p_contract_id;

  if not found then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  -- 只有 `active` 合同能生成应收（§5.5 的 409 STATE_CONFLICT）。
  -- `signed` 不算：签署到生效之间还有生效日校验，提前生成会在合同没生效时
  -- 就产生逾期应收，进而被总览统计成坏账。
  if contract_row.status <> 'active' then
    return jsonb_build_object(
      'status', 'contract_not_active',
      'contract_status', contract_row.status
    );
  end if;

  if p_periods is null or jsonb_typeof(p_periods) <> 'array'
    or jsonb_array_length(p_periods) = 0
  then
    return jsonb_build_object('status', 'periods_required');
  end if;

  -- 已有计划就整单拒绝：部分插入会让「合计 = 合同金额」在异常回滚后也不成立
  -- （比如 3 期里第 2 期撞唯一键，前 1 期已经落库）。
  if exists (
    select 1 from ops.receivables as existing where existing.contract_id = p_contract_id
  ) then
    return jsonb_build_object('status', 'plan_exists');
  end if;

  for entry, entry_index in
    select element.value, element.ordinality
    from jsonb_array_elements(p_periods) with ordinality as element (value, ordinality)
  loop
    entry_due := nullif(btrim(coalesce(entry ->> 'dueDate', '')), '')::date;

    if entry_due is null then
      return jsonb_build_object('status', 'due_date_required', 'period_no', entry_index);
    end if;

    begin
      entry_amount := (entry ->> 'amount')::numeric;
    exception
      when others then
        return jsonb_build_object('status', 'amount_invalid', 'period_no', entry_index);
    end;

    if entry_amount is null or entry_amount <= 0 then
      return jsonb_build_object('status', 'amount_invalid', 'period_no', entry_index);
    end if;

    -- 多于两位小数直接拒，不四舍五入：静默舍入会让合计差几分钱，而这条错误
    -- 要等到对账才对得上（见设计要点 7）。
    if entry_amount <> round(entry_amount, 2) then
      return jsonb_build_object(
        'status', 'amount_scale_invalid',
        'period_no', entry_index
      );
    end if;

    planned_total := planned_total + entry_amount;
  end loop;

  if planned_total <> contract_row.total_amount then
    return jsonb_build_object(
      'status', 'plan_total_mismatch',
      'planned_total', planned_total,
      'contract_total', contract_row.total_amount
    );
  end if;

  for entry, entry_index in
    select element.value, element.ordinality
    from jsonb_array_elements(p_periods) with ordinality as element (value, ordinality)
  loop
    insert into ops.receivables (
      contract_id, customer_id, period_no, due_date, amount, currency,
      note, created_by, updated_by
    )
    values (
      p_contract_id,
      contract_row.customer_id,
      -- 期号就是数组下标：入站不接受 `periodNo`，否则「第几期」由调用方决定，
      -- 出现重复或跳号时只能靠唯一键报错，而那个错误说不出是哪一期重复。
      entry_index,
      nullif(btrim(coalesce(entry ->> 'dueDate', '')), '')::date,
      (entry ->> 'amount')::numeric(14, 2),
      -- 币种从合同继承，请求里不接受币种：合同内混币会让应收、收款、退款三条
      -- 链路的币种各自漂移，而复合外键只能保证两两一致，保证不了整链一致。
      contract_row.currency,
      nullif(btrim(coalesce(entry ->> 'note', '')), ''),
      actor_id,
      actor_id
    )
    returning id into created_id;

    created_ids := array_append(created_ids, created_id);
  end loop;

  return jsonb_build_object(
    'status', 'ok',
    -- 按 `period_no` 排，不能按 id：`created_ids` 存的是 uuid，按字典序排出来的
    -- 顺序与期号无关，表现为「创建返回的数组顺序随机」——前端拿 items[0] 当首期
    -- 就是错的，而且时对时错，最容易被当成偶发。
    'items', coalesce(
      (
        select jsonb_agg(ops.receivable_json(entry.id) order by entry.period_no)
        from ops.receivables as entry
        where entry.id = any (created_ids)
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- 展期（契约 §5.5 第四条）。
--
-- `select ... for update` 锁住这一行：两个人同时展期，后到的那次会读到前一次
-- 提交后的 `version`，从而在版本校验上失败，而不是把前一次的新日期覆盖掉。
CREATE OR REPLACE FUNCTION ops.extend_receivable (
  p_receivable_id uuid,
  p_new_due_date date,
  p_reason text,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.receivables;
  net numeric(14, 2);
  extension_row ops.receivable_extensions;
begin
  perform ops.require_permission('receivable.write');

  select * into target
  from ops.receivables as entry
  where entry.id = p_receivable_id
  for update;

  if not found then
    return jsonb_build_object('status', 'receivable_not_found');
  end if;

  if p_expected_version is not null and p_expected_version <> target.version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  -- 已结清不允许展期（§6.4 的 RECEIVABLE_SETTLED）。判据与状态函数同源：
  -- 直接用 net 比较，不调状态函数——状态函数还会判 overdue/partial，
  -- 而这里只关心「收满了没有」。
  net := target.allocated_amount - target.reversed_amount;

  if net >= target.amount then
    return jsonb_build_object(
      'status', 'receivable_settled',
      'allocated_amount', target.allocated_amount,
      'reversed_amount', target.reversed_amount
    );
  end if;

  if p_new_due_date is null or p_new_due_date <= target.due_date then
    return jsonb_build_object(
      'status', 'invalid_due_date',
      'current_due_date', target.due_date
    );
  end if;

  insert into ops.receivable_extensions (
    receivable_id, previous_due_date, new_due_date, reason, created_by
  )
  values (
    p_receivable_id, target.due_date, p_new_due_date, btrim(p_reason), actor_id
  )
  returning * into extension_row;

  update ops.receivables
  set
    due_date = p_new_due_date,
    version = version + 1,
    updated_by = actor_id,
    updated_at = now()
  where id = p_receivable_id;

  return jsonb_build_object(
    'status', 'ok',
    'receivable', ops.receivable_json(p_receivable_id),
    'extension', jsonb_build_object(
      'id', extension_row.id,
      'previous_due_date', extension_row.previous_due_date,
      'new_due_date', extension_row.new_due_date,
      'reason', extension_row.reason,
      'created_by', extension_row.created_by,
      'created_at', extension_row.created_at
    )
  );
end;
$$;


-- ── 连带修改：合同详情的 `receivables[]` 换成契约形状 ──────────────────────
--
-- T-06 落地时这张表还不存在，`get_contract` 用 `to_regclass` 守卫生成
-- `jsonb_agg(to_jsonb(entry))`——那是「原始行透传」，键名是表列、没有
-- `status` / `outstanding` 派生。契约 §5.4 的 `GET /contracts/{id}` 要求
-- `receivables[]` 是摘要数组，与 §5.5 列表项同形。表一落地，透传就会把
-- snake_case 原始行直接吐给前端，且缺两个最常用的字段。
--
-- 这里不改 T-06 的迁移文件（迁移是历史，改它等于让已跑的库与文件不一致），
-- 而是用 CREATE OR REPLACE 覆盖同一个函数，只换 receivables 那一段。
CREATE OR REPLACE FUNCTION ops.get_contract (p_contract_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
  attachments jsonb;
  receivables jsonb := '[]'::jsonb;
  subscriptions jsonb := '[]'::jsonb;
  licenses jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('contract.read');

  if not exists (
    select 1 from ops.contracts as contract where contract.id = p_contract_id
  ) then
    return jsonb_build_object('status', 'contract_not_found');
  end if;

  select coalesce(
    jsonb_agg(ops.contract_item_json(item.id) order by item.line_no),
    '[]'::jsonb
  )
  into items
  from ops.contract_items as item
  where item.contract_id = p_contract_id;

  select coalesce(
    jsonb_agg(
      ops.attachment_json(attachment.id)
      order by attachment.uploaded_at, attachment.id
    ),
    '[]'::jsonb
  )
  into attachments
  from ops.contract_attachments as attachment
  where attachment.contract_id = p_contract_id;

  if to_regclass('ops.receivables') is not null then
    execute $sql$
      select coalesce(
        jsonb_agg(ops.receivable_json(entry.id) order by entry.period_no, entry.id),
        '[]'::jsonb
      )
      from ops.receivables as entry
      where entry.contract_id = $1
    $sql$ into receivables using p_contract_id;
  end if;

  if to_regclass('ops.subscriptions') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
      from ops.subscriptions as entry
      where entry.contract_id = $1
    $sql$ into subscriptions using p_contract_id;
  end if;

  if to_regclass('ops.licenses') is not null then
    execute $sql$
      select coalesce(jsonb_agg(to_jsonb(entry)), '[]'::jsonb)
      from ops.licenses as entry
      where entry.contract_id = $1
    $sql$ into licenses using p_contract_id;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'contract', ops.contract_json(p_contract_id),
    'items', items,
    'receivables', receivables,
    'subscriptions', subscriptions,
    'licenses', licenses,
    'attachments', attachments
  );
end;
$$;


REVOKE ALL ON TABLE ops.receivables,
ops.receivable_extensions
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.receivables ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.receivable_extensions ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON function ops.receivable_today ()
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.receivable_status (numeric, numeric, numeric, date, date)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.receivable_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_receivables (
  uuid,
  uuid,
  TEXT[],
  date,
  date,
  boolean,
  text,
  boolean,
  integer,
  integer
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_receivable (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_receivable_plan (uuid, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.extend_receivable (uuid, date, text, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_contract (uuid)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.receivable_today () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_receivables (
  uuid,
  uuid,
  TEXT[],
  date,
  date,
  boolean,
  text,
  boolean,
  integer,
  integer
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_receivable (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_receivable_plan (uuid, jsonb) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.extend_receivable (uuid, date, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_contract (uuid) TO authenticated,
service_role;


COMMENT ON TABLE ops.receivables IS '应收计划（契约 §3.4）。一合同多期，period_no 合同内唯一；状态是派生值不落库；allocated/reversed 各自独立，撤销不改核销记录。';


COMMENT ON TABLE ops.receivable_extensions IS '应收展期记录，仅 INSERT。previous_due_date 是历史到期日的唯一来源——receivables.due_date 会被新日期覆盖。';


COMMENT ON function ops.receivable_today () IS '业务时区 Asia/Shanghai 的今天。所有逾期判定共用，避免 UTC 服务器在 00:00–08:00 差一天。';


COMMENT ON function ops.receivable_status (numeric, numeric, numeric, date, date) IS '应收状态派生（契约 §3.4 五档优先级）：reversed / paid / overdue / partial / upcoming。unpaid 是保留值，v1 不返回。';


COMMENT ON function ops.list_receivables (
  uuid,
  uuid,
  TEXT[],
  date,
  date,
  boolean,
  text,
  boolean,
  integer,
  integer
) IS '应收列表与汇总。summary 基于筛选后全量而非当前页，翻页时合计不跳。';


COMMENT ON function ops.create_receivable_plan (uuid, jsonb) IS '生成整份应收计划；合计必须等于合同金额（PLAN_TOTAL_MISMATCH），合同须为 active，已有计划返回 plan_exists。';


COMMENT ON function ops.extend_receivable (uuid, date, text, integer) IS '展期：仅未结清可展期（已结清返回 receivable_settled），新日期须严格晚于当前日期，写 extension 后覆盖 due_date 并 version+1。';