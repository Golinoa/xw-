-- 运营报表：四个只读聚合（契约 §5.9 的 `/reports/*`、§10 口径映射、T-13）。
--
-- 报表域和别的域最大的不同：**它不写任何东西**。四个函数全是 `stable` 只读，
-- 所以这一份迁移里没有状态机、没有审计、没有并发守卫。要小心的是另一件事——
-- 口径。
--
-- 三条贯穿四个报表的规则：
--
-- 1. **应收口径只从 `ops.v_receivable_status` 读**（§10 的统一载体）。
--    报表自己写一遍 `amount - (allocated - reversed)` 也能算对，但只要有一处
--    漏掉 `reversed_amount`，「同一时点的两个页面」就会差出来，而且不报错。
--
-- 2. **`statistics_at` 在函数入口取一次**（与总览同一个理由）。报表里每个
--    聚合都带 `due_date < today` 这类边界，跨零点会得到自相矛盾的两半。
--
-- 3. **分组键与展示名分开**：`key` 是机器用的（customerId / contractId /
--    `2026-11`），`label` 是给人看的（客户名 / 合同号 / `2026 年 11 月`）。
--    只回 key 会逼前端为每行再查一次（N+1），只回 label 则无法再下钻。
--
-- 四个报表各有一个「契约没写死、实现必须选一边」的决定：
--
--   - `report_receivables` 的 `group_by` 缺省取 `customer`：报表的默认读者是
--     商务，最常问的是「哪些客户欠钱」。另一个选项「按应收逐行」与
--     `/receivables` 完全重复，没有存在的理由。
--   - `report_expiring_entitlements` 的 `subject_type` 缺省取「两种都要」：
--     契约把它列成可选筛选，而运营最常问的是「这个月有什么要到期」，
--     不分订阅还是授权。
--   - `report_tenant_sync_failures` 的「失败」定义沿用 §10：**每个映射的最新
--     一条命令**是 `failed`。按「存在失败命令」数会让这个报表只增不减——
--     一个映射失败三次、第四次成功，它现在是好的。
--   - `report_deployment_versions` 只数**有效实例**（`active` / `maintenance`）：
--     `planned` 还没上线、`retired` 已经下线，把它们算进「版本分布」等于把
--     历史包袱混进现状。
-- ── 1. 应收报表 ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.report_receivables (
  p_customer_id uuid DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_due_from date DEFAULT NULL,
  p_due_to date DEFAULT NULL,
  p_group_by text DEFAULT 'customer'
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  statistics_at timestamptz := now();
  today_date date := ops.receivable_today();
  group_by text := coalesce(nullif(btrim(p_group_by), ''), 'customer');
  result jsonb;
  totals jsonb;
  rows_json jsonb;
begin
  perform ops.require_permission('receivable.read');

  if group_by not in ('customer', 'contract', 'dueMonth') then
    return jsonb_build_object('status', 'invalid_group_by', 'value', group_by);
  end if;

  with scoped as (
    select entry.*
    from ops.v_receivable_status as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (p_contract_id is null or entry.contract_id = p_contract_id)
      and (p_due_from is null or entry.due_date >= p_due_from)
      and (p_due_to is null or entry.due_date <= p_due_to)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
  ),
  grouped as (
    select
      case group_by
        when 'contract' then scoped.contract_id::text
        when 'dueMonth' then to_char(scoped.due_date, 'YYYY-MM')
        else scoped.customer_id::text
      end as group_key,
      count(*) as row_count,
      sum(scoped.amount) as total_amount,
      sum(scoped.net_amount) as settled_amount,
      sum(scoped.outstanding_amount) as outstanding_amount,
      sum(
        case when scoped.status = 'overdue' then scoped.outstanding_amount else 0 end
      ) as overdue_amount
    from scoped
    group by 1
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'key', grouped.group_key,
          -- 展示名按分组维度取：客户名 / 合同号 / 年月。取不到时回退到 key
          -- 本身——报表里出现一列空白比出现一个 id 更难排障。
          'label', coalesce(
            case group_by
              when 'contract' then (
                select contract.contract_no
                from ops.contracts as contract
                where contract.id::text = grouped.group_key
              )
              when 'dueMonth' then to_char(
                to_date(grouped.group_key || '-01', 'YYYY-MM-DD'),
                'YYYY" 年 "MM" 月"'
              )
              else (
                select customer.name
                from ops.customers as customer
                where customer.id::text = grouped.group_key
              )
            end,
            grouped.group_key
          ),
          'count', grouped.row_count,
          'total_amount', round(grouped.total_amount, 2),
          'settled_amount', round(grouped.settled_amount, 2),
          'outstanding_amount', round(grouped.outstanding_amount, 2),
          'overdue_amount', round(grouped.overdue_amount, 2)
        )
        order by
          -- 欠得最多的排前面，而不是按 id 排：报表的默认读者先看异常。
          grouped.outstanding_amount desc,
          grouped.group_key asc
      ),
      '[]'::jsonb
    )
  into rows_json
  from grouped;

  -- 合计从明细行重算，不从 `rows[]` 相加：分组是展示方式，合计是事实。
  -- 两者万一不同（例如某个 key 落到 label 回退分支），这里是唯一能发现的地方。
  select jsonb_build_object(
    'count', coalesce(count(*), 0),
    'total_amount', round(coalesce(sum(entry.amount), 0), 2),
    'settled_amount', round(coalesce(sum(entry.net_amount), 0), 2),
    'outstanding_amount', round(coalesce(sum(entry.outstanding_amount), 0), 2),
    'overdue_amount', round(
      coalesce(
        sum(case when entry.status = 'overdue' then entry.outstanding_amount else 0 end),
        0
      ),
      2
    )
  )
  into totals
  from ops.v_receivable_status as entry
  where (p_customer_id is null or entry.customer_id = p_customer_id)
    and (p_contract_id is null or entry.contract_id = p_contract_id)
    and (p_due_from is null or entry.due_date >= p_due_from)
    and (p_due_to is null or entry.due_date <= p_due_to)
    and (
      p_statuses is null
      or cardinality(p_statuses) = 0
      or entry.status = any (p_statuses)
    );

  result := jsonb_build_object(
    'status', 'ok',
    'statistics_at', statistics_at,
    'group_by', group_by,
    'rows', rows_json,
    'totals', totals,
    -- `filters_echo` 不是给人看的：它让「这张报表是怎么算出来的」跟着数据一起
    -- 走。导出文件里没有它，事后就无法复现同一张报表。
    -- 六个键**全是 camelCase**，与契约里的筛选参数同名：这一块会被原样回给
    -- 前端、原样写进导出文件的元信息，出现一个 `group_by` 就等于让调用方按两套
    -- 命名读同一个对象。它与 `rows` / `totals` 的 snake_case 不矛盾——那些是
    -- 「形状函数出的列」，这一块是「请求参数的回声」。
    'filters_echo', jsonb_build_object(
      'customerId', p_customer_id,
      'contractId', p_contract_id,
      'status', to_jsonb(p_statuses),
      'dueFrom', p_due_from,
      'dueTo', p_due_to,
      'groupBy', group_by
    )
  );

  return result;
end;
$$;


-- ── 2. 临期权益报表 ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.report_expiring_entitlements (
  p_window_days integer DEFAULT NULL,
  p_subject_type text DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  statistics_at timestamptz := now();
  today_date date := ops.receivable_today();
  window_days integer;
  -- 变量名带 `filter_` 前缀：不带的话，`where ... unioned.subject_type =
  -- subject_type` 会撞上 CTE 里的同名列，PostgreSQL 直接报 ambiguous。
  filter_subject_type text := nullif(btrim(p_subject_type), '');
  rows_json jsonb;
begin
  perform ops.require_permission('entitlement.read');

  window_days := coalesce(p_window_days, ops.setting_int('overview.expiryWindowDays', 30));

  if window_days < 1 or window_days > 365 then
    return jsonb_build_object('status', 'invalid_window', 'value', window_days);
  end if;

  -- `subject_type` 的取值是 `subscription` / `licence`（契约 §3.5 的两张表）。
  -- 未知值回 `invalid_subject_type` 而不是静默返回空列表：空列表会让调用方
  -- 以为「确实没有临期的」，而实际是他把枚举拼错了。
  if filter_subject_type is not null and filter_subject_type not in ('subscription', 'licence') then
    return jsonb_build_object('status', 'invalid_subject_type', 'value', filter_subject_type);
  end if;

  with unioned as (
    select
      'subscription'::text as subject_type,
      entry.id,
      entry.customer_id,
      entry.product_id,
      entry.status,
      entry.ends_on as valid_to
    from ops.subscriptions as entry
    where entry.status = 'active'
      and entry.ends_on is not null
      and entry.ends_on between today_date and today_date + window_days

    union all

    select
      'licence'::text as subject_type,
      entry.id,
      entry.customer_id,
      null::uuid as product_id,
      entry.status,
      entry.valid_to
    from ops.private_licenses as entry
    where entry.status = 'active'
      and entry.valid_to is not null
      and entry.valid_to between today_date and today_date + window_days
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'subject_type', unioned.subject_type,
        'id', unioned.id,
        'customer', jsonb_build_object(
          'id', customer.id,
          'customer_no', customer.customer_no,
          'name', customer.name
        ),
        'product', case
          when unioned.product_id is null then null
          else (
            select jsonb_build_object('id', product.id, 'name', product.name)
            from ops.products as product
            where product.id = unioned.product_id
          )
        end,
        'status', unioned.status,
        'valid_to', unioned.valid_to,
        -- 剩余天数是**派生值**、不落库：它每天都在变，落库就必须有定时任务刷，
        -- 而任务没跑的那段时间里，报表和列表会各说一套（与 o-t12 的 isOverdue
        -- 同一个理由）。到期当天算 0 天，不是 1 天。
        'days_remaining', unioned.valid_to - today_date
      )
      order by unioned.valid_to asc, unioned.subject_type, unioned.id
    ),
    '[]'::jsonb
  )
  into rows_json
  from unioned
  join ops.customers as customer on customer.id = unioned.customer_id
  where filter_subject_type is null or unioned.subject_type = filter_subject_type;

  return jsonb_build_object(
    'status', 'ok',
    'statistics_at', statistics_at,
    'window_days', window_days,
    'rows', rows_json
  );
end;
$$;


-- ── 3. 租户同步失败报表 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.report_tenant_sync_failures (
  p_command_type text DEFAULT NULL,
  p_created_from date DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  statistics_at timestamptz := now();
  filter_command_type text := nullif(btrim(p_command_type), '');
  rows_json jsonb;
begin
  perform ops.require_permission('tenant.read');

  if filter_command_type is not null and filter_command_type not in (
    'provision', 'bind', 'activate', 'suspend', 'resume',
    'sync_entitlement', 'extend', 'revoke'
  ) then
    return jsonb_build_object('status', 'invalid_command_type', 'value', filter_command_type);
  end if;

  -- 「每个映射的最新一条命令是 failed」（§10）。这里有两件事必须分开：
  --
  -- 1. **先取最新，再判失败**。第一版把 `status = 'failed'` 写在 CTE 里，
  --    取到的是「每个映射最新的那条**失败**命令」——一个映射失败三次、第四次
  --    成功，它仍然在报表里，而且永远出不来。这个报表只增不减，运营会开始
  --    无视它。判失败的 WHERE 必须落在 distinct on 之外。
  -- 2. **没有失败过但也没有新命令的映射不进报表**：报表回答的是「现在什么卡住了」，
  --    「一直没人下发」是另一个问题（租户列表的 `pending` 就是它）。
  --
  -- `p_command_type` 与 `p_created_from` 落在 CTE 里，也就是先把人口范围收窄、
  -- 再取最新：这两个参数是「报表的筛选条件」，不是「失败的定义」。反过来做的话，
  -- 按类型筛选会把「这个类型最新一条失败了」变成「这个类型历史上失败过」，
  -- 又把刚修好的毛病带回来。
  with latest as (
    select distinct on (command.mapping_id)
      command.id,
      command.command_no,
      command.mapping_id,
      command.customer_id,
      command.command_type,
      command.status,
      command.attempt_count,
      command.last_error_category,
      command.last_error_code,
      command.created_at
    from ops.tenant_commands as command
    where command.mapping_id is not null
      and (filter_command_type is null or command.command_type = filter_command_type)
      and (p_created_from is null or command.created_at::date >= p_created_from)
    order by command.mapping_id, command.created_at desc, command.id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'command_id', latest.id,
        'command_no', latest.command_no,
        'mapping', jsonb_build_object(
          'id', mapping.id,
          'mapping_no', mapping.mapping_no
        ),
        'customer', jsonb_build_object(
          'id', customer.id,
          'customer_no', customer.customer_no,
          'name', customer.name
        ),
        'command_type', latest.command_type,
        'attempt_count', latest.attempt_count,
        'last_error_category', latest.last_error_category,
        'last_error_code', latest.last_error_code,
        -- 最后一次尝试的时刻来自 attempts 表的 `started_at`：命令行上的
        -- `created_at` 是「建单时刻」，重试三次之后它离现场已经很远了。
        'last_attempt_at', (
          select max(attempt.started_at)
          from ops.tenant_command_attempts as attempt
          where attempt.command_id = latest.id
        )
      )
      order by latest.created_at desc, latest.id
    ),
    '[]'::jsonb
  )
  into rows_json
  from latest
  join ops.tenant_mappings as mapping on mapping.id = latest.mapping_id
  -- 客户从**映射**取，不从命令行取：`tenant_commands.customer_id` 可空
  -- （o-t10 允许只挂合同的命令），拿它 join 会让整行静默消失——报表变成空表
  -- 而不报错，是最难查的一种「看起来没问题」。
  join ops.customers as customer on customer.id = mapping.customer_id
  where latest.status = 'failed';

  return jsonb_build_object(
    'status', 'ok',
    'statistics_at', statistics_at,
    'rows', rows_json
  );
end;
$$;


-- ── 4. 部署版本分布报表 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.report_deployment_versions (
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  statistics_at timestamptz := now();
  rows_json jsonb;
  unknown_count integer;
begin
  perform ops.require_permission('deployment.read');

  with scoped as (
    select entry.*
    from ops.deployment_instances as entry
    where entry.status in ('active', 'maintenance')
      and (p_customer_id is null or entry.customer_id = p_customer_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
  )
  select
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'version', grouped.version,
          'instance_count', grouped.instance_count,
          'customers', grouped.customers
        )
        order by grouped.version
      ) filter (where grouped.version is not null),
      '[]'::jsonb
    ),
    -- 没有登记版本的实例单独一列（§10「缺失版本单列 unknown」）。混进某个
    -- 版本号里会让「1.4.0 有 5 台」这句话变成假的。
    count(*) filter (where grouped.version is null)
  into rows_json, unknown_count
  from (
    select
      scoped.current_version as version,
      count(*) as instance_count,
      jsonb_agg(
        jsonb_build_object(
          'id', customer.id,
          'customer_no', customer.customer_no,
          'name', customer.name
        )
        order by customer.name, customer.id
      ) as customers
    from scoped
    join ops.customers as customer on customer.id = scoped.customer_id
    group by scoped.current_version
  ) as grouped;

  return jsonb_build_object(
    'status', 'ok',
    'statistics_at', statistics_at,
    'rows', rows_json,
    'unknown_version_count', coalesce(unknown_count, 0)
  );
end;
$$;


REVOKE ALL ON function ops.report_receivables (uuid, uuid, TEXT[], date, date, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.report_expiring_entitlements (integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.report_tenant_sync_failures (text, date)
FROM
  public,
  anon;


REVOKE ALL ON function ops.report_deployment_versions (uuid, TEXT[])
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.report_receivables (uuid, uuid, TEXT[], date, date, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.report_expiring_entitlements (integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.report_tenant_sync_failures (text, date) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.report_deployment_versions (uuid, TEXT[]) TO authenticated,
service_role;


COMMENT ON function ops.report_receivables (uuid, uuid, TEXT[], date, date, text) IS '应收报表（契约 §5.9）。只从 ops.v_receivable_status 读；totals 从明细重算，不由 rows[] 相加。';


COMMENT ON function ops.report_expiring_entitlements (integer, text) IS '临期权益报表。days_remaining 是派生值，不落库。';


COMMENT ON function ops.report_tenant_sync_failures (text, date) IS '租户同步失败报表。口径是「每个映射的最新一条命令 failed」，不是「存在失败命令」。';


COMMENT ON function ops.report_deployment_versions (uuid, TEXT[]) IS '部署版本分布。只数 active/maintenance；无版本的实例单列 unknown_version_count。';