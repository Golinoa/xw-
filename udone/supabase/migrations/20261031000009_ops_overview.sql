-- 运营总览：统一口径视图 + `GET /overview`（契约 §5.9 第一条、§10 口径映射、T-13）。
--
-- 这一域的难点不在端点，在**口径**。契约 §10 末尾那句是硬要求：
--
--   「所有指标、报表、导出必须调用同一组 SQL 视图/函数，禁止前端或报表各自实现」
--
-- 而 T-13 的验收断言把它变成了可测的一件事：`/overview` 的
-- `amounts[currency=CNY].overdueReceivable` 必须与 `/receivables?status=overdue`
-- 的 `summary.overdueAmount` **完全相等**。两个数各自写一遍 SQL 也能「大致相等」，
-- 但只要有一处把 `amount` 写成 `outstanding`、或者漏掉 `reversed_amount`，
-- 两个页面就会在某个客户身上差出来——而这类偏差不会报错，只会被当成「统计口径」。
--
-- 所以本迁移先落 `ops.v_receivable_status`：应收的**派生状态与净额**只在这里算
-- 一次，总览与四个报表都从它读。视图里的算式与 `ops.list_receivables` 的
-- `scoped` CTE 逐字相同（`amount - (allocated - reversed)`、`ops.receivable_status`
-- 的五个参数同一顺序），差别只是 `list_receivables` 有自己的分页与排序。
--
-- 五个设计要点：
--
-- 1. **`amounts[]` 不按合同状态过滤。** §10 的「合同待收金额」写着「仅限
--    `contracts.status IN ('signed','active')`」，但 T-13 的验收断言要求它与
--    `/receivables?status=overdue` 相等，而那个端点**不过滤合同状态**。两条同时
--    成立只有一个读法：总览的金额与应收列表是同一集合。视图仍然带出
--    `contract_status` 供报表用，但总览的聚合不筛它。这是一处契约内部张力，
--    登记为协作项而不是悄悄选一边。
--
-- 2. **无权的指标不进 `metrics`，进 `restrictedMetrics[]`。** T-13 原文
--    「`/overview` 中不含其无权指标（返回 `restrictedMetrics[]` 而非 0 冒充）」。
--    用 0 冒充是最坏的形态：页面显示「逾期 0 元」，而真相是「你没权限看」。
--    实现按权限逐个判，缺权限时**连键都不出现**——前端按 `in` 判断，不按值判断。
--
-- 3. **`partialFailures[]` 与 `restrictedMetrics[]` 是两件事，都要有。**
--    §5.9 的 2026-10-30 形状定稿定义了 `partialFailures[{code,message,section?}]`
--    （统计不完整），T-13 任务书要求 `restrictedMetrics[]`（无权）。前者是
--    「数据本身不全」，后者是「你看不到」。合成一个字段会让前端无法区分
--    「该提示补数据」还是「该提示找管理员开权限」。两处措辞的差异登记为协作项。
--
-- 4. **`metrics` 里的两个金额是 CNY。** `pendingReceiptAmount` /
--    `unreconciledAmount` 是标量，而契约 §2.2 明令「总览按币种分组、不合并」。
--    标量与分组天然冲突，实现取 CNY（§2.2 的默认币种）；一旦库里存在非 CNY 的
--    待处理收款，就补一条 `partialFailures`（`RECEIPT_CURRENCY_MIX`）把这层
--    局限显式说出来，而不是让那两个数字看起来像「全部」。
--
-- 5. **`statisticsAt` 取函数入口的 `now()`，只取一次。** 同一次统计里七个
--    `count(*)` 若各自 `now()`，`due_date < today` 的边界可能在两次查询之间跨过
--    零点，出现「逾期 3 条，但列表里 4 条」。日期用 `ops.receivable_today()`
--    （Asia/Shanghai），与应收域同一个「今天」。
-- ── 1. 统一口径视图 ────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW ops.v_receivable_status AS
SELECT
  entry.id,
  entry.contract_id,
  contract.contract_no,
  contract.status AS contract_status,
  entry.customer_id,
  entry.currency,
  entry.period_no,
  entry.due_date,
  entry.amount,
  entry.allocated_amount,
  entry.reversed_amount,
  -- 净核销额与未收余额：报表的 settled / outstanding 都从这里取，不再各写一遍。
  entry.allocated_amount - entry.reversed_amount AS net_amount,
  entry.amount - (entry.allocated_amount - entry.reversed_amount) AS outstanding_amount,
  ops.receivable_status (
    entry.amount,
    entry.allocated_amount,
    entry.reversed_amount,
    entry.due_date,
    ops.receivable_today ()
  ) AS status
FROM
  ops.receivables AS entry
  JOIN ops.contracts AS contract ON contract.id = entry.contract_id;


-- ── 2. 总览 ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.get_ops_overview (p_window_days integer DEFAULT NULL) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  -- 只取一次（设计要点 5）。
  statistics_at timestamptz := now();
  today_date date := ops.receivable_today();
  window_days integer;
  metrics jsonb := '{}'::jsonb;
  restricted TEXT[] := array[]::TEXT[];
  partial jsonb := '[]'::jsonb;
  amounts jsonb;
  counted bigint;
  -- 金额单独用 numeric：赋给 bigint 会被隐式取整，`1234.56` 变成 1235 而看不出
  -- 是哪一步丢的。总览的金额要原样出门。
  total_amount numeric;
  -- 权限一次判完：`has_permission` 每条都查一次三张表，七个指标逐个判会查七次。
  can_customer boolean := ops.has_permission('customer.read');
  can_contract boolean := ops.has_permission('contract.read');
  can_tenant boolean := ops.has_permission('tenant.read');
  can_entitlement boolean := ops.has_permission('entitlement.read');
  can_ticket boolean := ops.has_permission('ticket.read');
  can_receivable boolean := ops.has_permission('receivable.read');
begin
  perform ops.require_permission('overview.read');

  window_days := coalesce(
    p_window_days,
    ops.setting_int('overview.expiryWindowDays', 30)
  );

  -- 越界回错误信封而不是截断：前端传 0 天想要「今天到期」，静默改成 1 天会让
  -- 他以为筛选生效了。契约 §5.9 的 PATCH 一条也写了「越界回 400 而非静默截断」。
  if window_days < 1 or window_days > 365 then
    return jsonb_build_object('status', 'invalid_window', 'value', window_days);
  end if;

  -- 有效软件客户（§10）：`status='active'` 且存在已签/生效合同，或有效订阅/授权。
  -- 只数 `status='active'` 会把「签了合同但客户停在 prospect」的算进来，
  -- 那个数字在运营会上没有意义——它不指向任何一份可收的钱。
  if can_customer then
    select count(*) into counted
    from ops.customers as entry
    where entry.status = 'active'
      and (
        exists (
          select 1 from ops.contracts as contract
          where contract.customer_id = entry.id
            and contract.status in ('signed', 'active')
        )
        or exists (
          select 1 from ops.subscriptions as subscription
          where subscription.customer_id = entry.id
            and subscription.status = 'active'
        )
        or exists (
          select 1 from ops.private_licenses as license
          where license.customer_id = entry.id
            and license.status = 'active'
        )
      );

    metrics := metrics || jsonb_build_object('active_customers', counted);
  else
    restricted := array_append(restricted, 'active_customers');
  end if;

  -- 生效合同：契约没给口径，取与「合同待收金额」同一个集合（signed + active）。
  -- `draft` 还没签、`terminated`/`expired` 已经不在履约中。
  if can_contract then
    select count(*) into counted
    from ops.contracts as entry
    where entry.status in ('signed', 'active');

    metrics := metrics || jsonb_build_object('active_contracts', counted);
  else
    restricted := array_append(restricted, 'active_contracts');
  end if;

  -- 运行中租户（§10）：`mapping_status='active'` 且 `last_known_state='active'`，
  -- 按 `udone_organization_id` 去重。
  --
  -- §10 还写「最新命令 succeeded」——那一条由 `mapping_status='active'` 本身保证：
  -- 这张表的状态只由 `record_tenant_command_attempt` 在 `succeeded` 那一刻推进
  -- （o-t10 的状态机），运营端点推不动它。所以不需要再去 lateral 查最新命令。
  --
  -- 按 org id 去重而不是按映射行：契约 §3.6 的 `UNIQUE(udone_organization_id)`
  -- 让两者相等，但可空列上那个唯一约束允许 NULL 并存，所以还必须排掉 NULL
  -- ——否则一条「开通失败、还没绑 org」的映射会被算成一个运行中的租户。
  if can_tenant then
    select count(distinct entry.udone_organization_id) into counted
    from ops.tenant_mappings as entry
    where entry.mapping_status = 'active'
      and entry.last_known_state = 'active'
      and entry.udone_organization_id is not null;

    metrics := metrics || jsonb_build_object('running_tenants', counted);
  else
    restricted := array_append(restricted, 'running_tenants');
  end if;

  if can_entitlement then
    select
      (
        select count(*) from ops.subscriptions as entry where entry.status = 'active'
      ) + (
        select count(*) from ops.private_licenses as entry where entry.status = 'active'
      )
    into counted;

    metrics := metrics || jsonb_build_object('active_entitlements', counted);

    -- 临期（§10）：窗口内到期。订阅看 `ends_on`、授权看 `valid_to`——两张表
    -- 的列名不同但语义同一个，各自写清楚比合成一个 coalesce 更好读。
    -- 永久授权 `valid_to` 为 NULL（表约束保证），不可能临期，天然被 NULL 比较排除。
    select
      (
        select count(*)
        from ops.subscriptions as entry
        where entry.status = 'active'
          and entry.ends_on is not null
          and entry.ends_on between today_date and today_date + window_days
      ) + (
        select count(*)
        from ops.private_licenses as entry
        where entry.status = 'active'
          and entry.valid_to is not null
          and entry.valid_to between today_date and today_date + window_days
      )
    into counted;

    metrics := metrics || jsonb_build_object('expiring_entitlements', counted);
  else
    restricted := array_append(
      array_append(restricted, 'active_entitlements'),
      'expiring_entitlements'
    );
  end if;

  if can_ticket then
    select count(*) into counted
    from ops.tickets as entry
    where entry.status not in ('resolved', 'closed');

    metrics := metrics || jsonb_build_object('open_tickets', counted);

    select count(*) into counted
    from ops.tickets as entry
    where entry.status = 'waiting';

    metrics := metrics || jsonb_build_object('waiting_tickets', counted);
  else
    restricted := array_append(
      array_append(restricted, 'open_tickets'),
      'waiting_tickets'
    );
  end if;

  -- 同步失败（§10）：每个映射的**最新**一条命令是 `failed`。
  -- `distinct on` 而不是「有失败命令的映射数」：一个映射失败过三次、第四次成功，
  -- 它现在是好的；按「存在失败」数会让这个指标只增不减。
  if can_tenant then
    select count(*) into counted
    from (
      select distinct on (entry.mapping_id)
        entry.mapping_id,
        entry.status
      from ops.tenant_commands as entry
      where entry.mapping_id is not null
      order by entry.mapping_id, entry.created_at desc, entry.id
    ) as latest
    where latest.status = 'failed';

    metrics := metrics || jsonb_build_object('failed_sync_commands', counted);
  else
    restricted := array_append(restricted, 'failed_sync_commands');
  end if;

  -- 两个收款金额（§2.2 的默认币种 CNY，设计要点 4）。
  if can_receivable then
    select coalesce(sum(entry.amount), 0) into total_amount
    from ops.receipts as entry
    where entry.status = 'recorded'
      and entry.currency = 'CNY';

    metrics := metrics || jsonb_build_object('pending_receipt_amount', total_amount);

    select coalesce(sum(entry.amount), 0) into total_amount
    from ops.receipts as entry
    where entry.status = 'pending_reconcile'
      and entry.currency = 'CNY';

    metrics := metrics || jsonb_build_object('unreconciled_amount', total_amount);

    if exists (
      select 1 from ops.receipts as entry
      where entry.status in ('recorded', 'pending_reconcile')
        and entry.currency <> 'CNY'
    ) then
      partial := partial || jsonb_build_object(
        'code', 'RECEIPT_CURRENCY_MIX',
        'message', '待审核/待核销收款存在非人民币记录，metrics 里的两个金额只统计 CNY',
        'section', 'metrics'
      );
    end if;
  else
    restricted := array_append(
      array_append(restricted, 'pending_receipt_amount'),
      'unreconciled_amount'
    );
  end if;

  -- 按币种分组（§2.2「总览按币种分组、不合并」）。
  --
  -- `total` 取应收原额、`settled` 取净核销额、`overdue` 是未收余额里逾期那块、
  -- `upcoming` 是未到期那块的未收余额——四者是同一个分解：
  -- `total = settled + overdue + upcoming + 其他（reversed 区的残值）`。
  -- 与 `list_receivables` 的 summary 逐字一致（同一个视图、同一列算式）。
  if can_receivable then
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'currency', agg.currency,
          'total_receivable', round(agg.total_amount, 2),
          'settled_receivable', round(agg.settled_amount, 2),
          'overdue_receivable', round(agg.overdue_amount, 2),
          'upcoming_receivable', round(agg.upcoming_amount, 2)
        )
        order by agg.currency
      ),
      '[]'::jsonb
    )
    into amounts
    from (
      select
        entry.currency,
        sum(entry.amount) as total_amount,
        sum(entry.net_amount) as settled_amount,
        sum(
          case when entry.status = 'overdue' then entry.outstanding_amount else 0 end
        ) as overdue_amount,
        -- 不再判 `due_date >= today`：`upcoming` / `partial` 两档的定义本身
        -- 就含「未到期」（`ops.receivable_status` 里 overdue 的判定在前），
        -- 再加一遍是同一件事写两次——实测变异（删掉这个条件）一条断言都没变红，
        -- 说明它是死的。口径只有一个来源，不在这里留第二份。
        sum(
          case
            when entry.status in ('upcoming', 'partial') then entry.outstanding_amount
            else 0
          end
        ) as upcoming_amount
      from ops.v_receivable_status as entry
      group by entry.currency
    ) as agg;
  else
    amounts := '[]'::jsonb;
    restricted := array_append(restricted, 'amounts');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'statistics_at', statistics_at,
    'window_days', window_days,
    'metrics', metrics,
    'amounts', amounts,
    'restricted_metrics', to_jsonb(restricted),
    'partial_failures', partial
  );
end;
$$;


REVOKE ALL ON TABLE ops.v_receivable_status
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_ops_overview (integer)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.get_ops_overview (integer) TO authenticated,
service_role;


COMMENT ON VIEW ops.v_receivable_status IS '应收的派生状态与净额（契约 §10 的统一口径载体）。总览与四个报表都从这里读，算式与 ops.list_receivables 的 scoped CTE 逐字相同。';


COMMENT ON function ops.get_ops_overview (integer) IS '运营总览（契约 §5.9）。无权指标不进 metrics 而进 restrictedMetrics[]；metrics 里两个收款金额只统计 CNY，有非 CNY 待处理时补 RECEIPT_CURRENCY_MIX 到 partialFailures[]。';