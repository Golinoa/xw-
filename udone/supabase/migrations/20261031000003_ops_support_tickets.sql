-- 运营 support 域：工单三表 + 十四个函数（契约 §3.6、§5.6）。
--
-- 设计要点：
--
-- 1. **`isOverdue` 是派生值，不落库。** 与应收状态同一条理由：逾期随时间自己
--    发生，落库就必须有定时任务刷，任务没跑的那段时间里列表与总览各说一套。
--    这里把它落成 `ops.ticket_is_overdue(p_status, p_due_at, p_now)`——`p_now`
--    显式传入而不是函数里调 `now()`，因为逾期边界（差一秒、差一天）在 pgTAP 里
--    必须能直接对着值断言，不能靠「跑测试时恰好是几点」。
--
-- 2. **`due_at` 在创建时算一次，之后不随设置变化。** 契约 §11 U-11 写「`due_at`
--    由 `settings.ticket.dueHours` 按优先级系数计算」，但**系数没给**。本轮一律
--    用基线（四档同值），并把这件事写进看板协作项 C-107：如果按系数算，那么
--    「今天把 urgent 从 0.5 调到 0.25」不该让上周已创建的单子集体变成逾期——
--    存量单的 `due_at` 必须是快照。这也是它落库、而 `isOverdue` 不落库的原因：
--    一个是「约定的截止时刻」，一个是「现在过没过」。
--
-- 3. **状态机八条边全部返回 `{status}` 信封，不 RAISE。** PostgREST 会把异常
--    压成 400 泛化错误，前端拿不到「这条边不存在」与「缺 waitingOn」的区别。
--    只有权限不足走 `ops.require_permission` 抛 42501。
--
-- 4. **非法迁移必须回带 `allowed_actions`。** 契约 §5.6 的 409 明写
--    `details.allowedActions`：前端据此渲染按钮，而不是自己维护一份状态机副本
--    （两份状态机的漂移是这类页面最常见的缺陷）。状态机本体落在
--    `ops.allowed_ticket_actions`，详情、非法迁移、`allowedActions` 三处共用。
--
-- 5. **`waiting_on` 离开 waiting 时清空。** 表约束只要求「waiting 时必须有
--    waitingOn」，不清空也满足约束，但 `resume` 之后那一列会留着上一个等待对象，
--    而列表页与导出都会把它当成「正在等谁」。清空是让数据自己说真话。
--
-- 6. **`ticket_references` 的引用存在性本轮证不了。** 三张被引用的表
--    （`tenant_commands`、`entitlement_change_requests`、`deployment_version_records`）
--    分别属 o-t10 / o-t09 / o-t11，本轮都不存在。用 `to_regclass` 守卫：表不在
--    就跳过存在性校验，表一落地自动开始校验，本函数不用改（与客户域的
--    `customer_reference_counts` 同一手法）。**这条要在 journal 里记成未验证项**，
--    不能算「已验证引用校验」。
--
-- 7. **工单编号 `TK-` + 六位序列。** 契约 §3.0 要求 `前缀-YYYY-6 位`，实现与客户
--    （`CUS-`）、合同（`HT-`）一致，不带年份——三处同形是刻意的：跨年后编号不
--    体现年份，靠编号切「按年统计」本来就不成立。这条偏离已登记（C-102），工单
--    沿用同一口径，不单独再开一条。
CREATE SEQUENCE ops.ticket_no_seq AS bigint START
WITH
  1 INCREMENT BY 1;


CREATE TABLE ops.tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_no text NOT NULL DEFAULT (
    'TK-' || lpad(nextval('ops.ticket_no_seq')::text, 6, '0')
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  -- 三个可选引用里只有产品与合同有真外键：租户映射与部署实例两张表属 o-t10 /
  -- o-t11，本轮不存在。建不带外键的 uuid 列 + 写入时 to_regclass 守卫，
  -- 表落地后由后续迁移补外键（补约束比补列安全，不需要回填）。
  product_id uuid REFERENCES ops.products (id) ON DELETE RESTRICT,
  contract_id uuid REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  tenant_mapping_id uuid,
  deployment_instance_id uuid,
  subject text NOT NULL CHECK (length(btrim(subject)) > 0),
  description text NOT NULL CHECK (length(btrim(description)) > 0),
  -- 问题类型不建枚举：契约 §3.6 只写了 `text NOT NULL`，没给词表。自己编一套
  -- 会让前端下拉先被实现绑死（见 C-108）。
  issue_type text NOT NULL CHECK (length(btrim(issue_type)) > 0),
  priority text NOT NULL CHECK (priority IN ('urgent', 'high', 'normal', 'low')),
  status text NOT NULL CHECK (
    status IN (
      'new',
      'assigned',
      'in_progress',
      'waiting',
      'resolved',
      'closed'
    )
  ),
  assignee_operator_id uuid REFERENCES ops.operators (id) ON DELETE RESTRICT,
  waiting_on text,
  resolution_summary text,
  -- 创建时算出的截止时刻（见设计要点 2）。NULL 表示「没有内部时限」，
  -- 而不是「立刻逾期」：`ticket_is_overdue` 对 NULL 一律返回 false。
  due_at timestamptz,
  closed_at timestamptz,
  reopen_count integer NOT NULL DEFAULT 0 CHECK (reopen_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_no),
  -- 「等待状态必须有等待对象」落到表约束：状态机里再判一次是给用户看信封，
  -- 这里是给「有人绕过 RPC 改数据」兜底。
  CHECK (
    status <> 'waiting'
    OR (
      waiting_on IS NOT NULL
      AND length(btrim(waiting_on)) > 0
    )
  ),
  -- 关闭时刻与 closed 状态必须同时成立，否则 `closedAt` 会是「有值但没关」。
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);


CREATE INDEX tickets_status_priority_idx ON ops.tickets (status, priority, updated_at DESC);


CREATE INDEX tickets_assignee_status_idx ON ops.tickets (assignee_operator_id, status);


CREATE INDEX tickets_customer_idx ON ops.tickets (customer_id);


CREATE INDEX tickets_due_idx ON ops.tickets (due_at);


-- 时间线：只增不改不删。`event_type` 收七种，`linked` 由关联动作产生，
-- `comment` 由内部说明产生，其余四种由状态机产生。
CREATE TABLE ops.ticket_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES ops.tickets (id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (
    event_type IN (
      'created',
      'assigned',
      'status_changed',
      'comment',
      'linked',
      'reopened',
      'closed'
    )
  ),
  from_status text,
  to_status text,
  actor_id uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  body text,
  waiting_on text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX ticket_events_ticket_created_idx ON ops.ticket_events (ticket_id, created_at);


-- 关联：可把工单挂到租户同步任务、授权变更、部署升级记录上（PRD §6.9）。
-- 主键即去重键，「同一工单重复关联同一个对象」在库层就不可能成立。
CREATE TABLE ops.ticket_references (
  ticket_id uuid NOT NULL REFERENCES ops.tickets (id) ON DELETE RESTRICT,
  ref_type text NOT NULL CHECK (
    ref_type IN (
      'tenant_command',
      'entitlement_change',
      'deployment_version'
    )
  ),
  ref_id uuid NOT NULL,
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ticket_id, ref_type, ref_id)
);


CREATE INDEX ticket_references_ref_idx ON ops.ticket_references (ref_type, ref_id);


-- 业务时区某一天的起点。与 `ops.receivable_today()` 同一套时区口径，但返回
-- 时刻而不是日期：工单的筛选要按「创建于哪一天」切，而 `created_at` 是 timestamptz，
-- 直接拿日期比会把北京时间 00:00–08:00 的单子算到前一天。
CREATE OR REPLACE FUNCTION ops.business_day_start (p_date date) returns timestamptz language sql immutable
SET
  search_path = '' AS $$
  select (p_date::timestamp at time zone 'Asia/Shanghai');
$$;


-- 工单状态机：某状态下允许的动作（契约 §3.6）。
--
-- 做成函数而不是在三个地方各写一遍 `case`：详情要回 `allowedActions`、非法迁移
-- 也要回、前端按钮还要靠它对账。三份副本里只要有一份漏了一条边，症状是「按钮
-- 点得动但一直 409」。
CREATE OR REPLACE FUNCTION ops.allowed_ticket_actions (p_status text) returns TEXT[] language sql immutable
SET
  search_path = '' AS $$
  select case p_status
    when 'new' then array['assign']::text[]
    when 'assigned' then array['start']::text[]
    when 'in_progress' then array['wait', 'resolve']::text[]
    when 'waiting' then array['resume', 'resolve']::text[]
    when 'resolved' then array['close', 'reopen']::text[]
    when 'closed' then array['reopen']::text[]
    else array[]::text[]
  end;
$$;


-- 创建时刻 + `settings.ticket.dueHours` 小时 = 内部截止时刻。
--
-- `stable` 不是 `immutable`：它读 `ops.settings`，标成 immutable 会让优化器把
-- 第一次读到的值缓存住，改了设置还是算旧时限。
CREATE OR REPLACE FUNCTION ops.ticket_due_at (p_from timestamptz) returns timestamptz language sql stable security definer
SET
  search_path = '' AS $$
  select p_from + make_interval(hours => ops.setting_int('ticket.dueHours', 48));
$$;


-- 是否逾期（契约 §5.6 的 `isOverdue`）。
--
-- `p_now` 显式传入，理由见设计要点 1。
-- **`resolved` 不算逾期**：契约原文是「`dueAt < now` 且未关闭」，字面只排除了
-- `closed`；但 `resolved` 意味着活儿已经干完，把它继续标成逾期会让「逾期工单」
-- 这个数字永远降不下来——而它正是总览里唯一会被人追问的指标。这条口径登记在
-- C-108，等运营端确认。
CREATE OR REPLACE FUNCTION ops.ticket_is_overdue (
  p_status text,
  p_due_at timestamptz,
  p_now timestamptz
) returns boolean language sql immutable
SET
  search_path = '' AS $$
  select coalesce(
    p_due_at is not null
    and p_status is not null
    and p_status not in ('resolved', 'closed')
    and p_due_at < p_now,
    false
  );
$$;


-- 单条工单的出站形状（snake_case，出站由 protocol.ts 转 camelCase）。
--
-- `assignee` 带 `display_name` 与 `status`：列表要直接渲染负责人名字，只回 id 会
-- 把一次列表变成 N+1（U-20 同一条理由）。不带邮箱——工单列表不需要，带了就多
-- 一次「为什么这里能看到邮箱」的追问。
CREATE OR REPLACE FUNCTION ops.ticket_json (p_ticket_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', entry.id,
    'ticket_no', entry.ticket_no,
    'customer_id', entry.customer_id,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name
    ),
    'product_id', entry.product_id,
    'contract_id', entry.contract_id,
    'tenant_mapping_id', entry.tenant_mapping_id,
    'deployment_instance_id', entry.deployment_instance_id,
    'subject', entry.subject,
    'description', entry.description,
    'issue_type', entry.issue_type,
    'priority', entry.priority,
    'status', entry.status,
    'assignee', (
      select jsonb_build_object(
        'id', assignee.id,
        'display_name', assignee.display_name,
        'status', assignee.status
      )
      from ops.operators as assignee
      where assignee.id = entry.assignee_operator_id
    ),
    'waiting_on', entry.waiting_on,
    'resolution_summary', entry.resolution_summary,
    'due_at', entry.due_at,
    'is_overdue', ops.ticket_is_overdue(entry.status, entry.due_at, now()),
    'closed_at', entry.closed_at,
    'reopen_count', entry.reopen_count,
    'version', entry.version,
    'created_at', entry.created_at,
    'updated_at', entry.updated_at
  )
  from ops.tickets as entry
  join ops.customers as customer on customer.id = entry.customer_id
  where entry.id = p_ticket_id;
$$;


-- 可指派成员（契约 §5.6 第二条与详情里的 `assignableOperators`）。
--
-- 只回 `active` 成员：`invited` 还没登录过、`disabled` 已停用，把他们放进分派
-- 下拉等于把工单分给一个不会看到它的人。不带邮箱——契约明写「不暴露邮箱」，
-- 而 `ticket.read` 是售后角色都有的低危权限，`operator.read` 不是。
--
-- 不按「有 ticket.update」过滤：契约只写「仅 active 成员」。权限矩阵将来若允许
-- 售后之外的角色接单，这里不该成为第二处需要同步的地方。
CREATE OR REPLACE FUNCTION ops.assignable_operators_json (p_keyword text DEFAULT NULL) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', operator.id,
        'display_name', operator.display_name,
        'status', operator.status
      )
      order by operator.display_name, operator.id
    ),
    '[]'::jsonb
  )
  from ops.operators as operator
  where operator.status = 'active'
    and (
      p_keyword is null
      or btrim(p_keyword) = ''
      or operator.display_name ilike '%' || btrim(p_keyword) || '%'
      or operator.email ilike '%' || btrim(p_keyword) || '%'
    );
$$;


-- 追加时间线事件。内部函数，四个入口（创建 / 分派 / 状态迁移 / 说明）共用，
-- 保证 `actor_id` 一律来自会话而不是入参——可传入的 actor 等于可伪造的时间线。
CREATE OR REPLACE FUNCTION ops.append_ticket_event (
  p_ticket_id uuid,
  p_event_type text,
  p_from_status text DEFAULT NULL,
  p_to_status text DEFAULT NULL,
  p_body text DEFAULT NULL,
  p_waiting_on text DEFAULT NULL,
  p_metadata jsonb DEFAULT '{}'::jsonb
) returns uuid language plpgsql security definer
SET
  search_path = '' AS $$
declare
  new_id uuid;
begin
  insert into ops.ticket_events (
    ticket_id, event_type, from_status, to_status, actor_id, body, waiting_on, metadata
  )
  values (
    p_ticket_id,
    p_event_type,
    p_from_status,
    p_to_status,
    ops.current_operator_id(),
    nullif(btrim(coalesce(p_body, '')), ''),
    nullif(btrim(coalesce(p_waiting_on, '')), ''),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning id into new_id;

  return new_id;
end;
$$;


-- 列表（契约 §5.6 第一条）。
--
-- 排序固定为「优先级高的在前，同优先级按截止时刻早的在前」：工单列表是工作队列，
-- 不是档案库。契约没给排序白名单，也就不开放 `sort` 参数——开放了却没有第二个
-- 有意义的排序键，前端只会多一个用不到的下拉。
CREATE OR REPLACE FUNCTION ops.list_tickets (
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_priorities TEXT[] DEFAULT NULL,
  p_assignee_operator_id uuid DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_updated_from date DEFAULT NULL,
  p_created_from date DEFAULT NULL,
  p_created_to date DEFAULT NULL,
  p_unassigned boolean DEFAULT FALSE,
  p_overdue_only boolean DEFAULT FALSE,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  now_at timestamptz := now();
  result jsonb;
begin
  perform ops.require_permission('ticket.read');

  with filtered as (
    select
      entry.*,
      case entry.priority
        when 'urgent' then 1
        when 'high' then 2
        when 'normal' then 3
        else 4
      end as priority_rank,
      ops.ticket_is_overdue(entry.status, entry.due_at, now_at) as is_overdue
    from ops.tickets as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (p_product_id is null or entry.product_id = p_product_id)
      and (
        p_assignee_operator_id is null
        or entry.assignee_operator_id = p_assignee_operator_id
      )
      and (
        not coalesce(p_unassigned, false)
        or entry.assignee_operator_id is null
      )
      -- 日期按业务时区整天切（见 `business_day_start`）：`p_created_to` 是「含这天」，
      -- 所以上界用次日零点，不是 `<=` 当天零点。
      and (
        p_updated_from is null
        or entry.updated_at >= ops.business_day_start(p_updated_from)
      )
      and (
        p_created_from is null
        or entry.created_at >= ops.business_day_start(p_created_from)
      )
      and (
        p_created_to is null
        or entry.created_at < ops.business_day_start(p_created_to + 1)
      )
  ),
  scoped as (
    select filtered.*
    from filtered
    where (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or filtered.status = any (p_statuses)
      )
      and (
        p_priorities is null
        or cardinality(p_priorities) = 0
        or filtered.priority = any (p_priorities)
      )
      and (not coalesce(p_overdue_only, false) or filtered.is_overdue)
  ),
  page as (
    select scoped.id
    from scoped
    order by
      scoped.priority_rank asc,
      scoped.due_at asc nulls last,
      scoped.updated_at desc,
      scoped.id asc
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from scoped),
    'items', coalesce(
      (
        select jsonb_agg(ops.ticket_json(page.id) order by
          scoped.priority_rank asc,
          scoped.due_at asc nulls last,
          scoped.updated_at desc,
          scoped.id asc
        )
        from page
        join scoped on scoped.id = page.id
      ),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end;
$$;


-- 详情（契约 §5.6 第四条）。
--
-- `timeline` 只带最近 50 条：详情页首屏要它，全量翻页走
-- `GET /tickets/{id}/timeline`。带全量会让「一张聊了半年的工单」把响应撑到几百 KB，
-- 而首屏只用得上最后几条。
CREATE OR REPLACE FUNCTION ops.get_ticket (p_ticket_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  target ops.tickets;
  timeline jsonb := '[]'::jsonb;
  reference_list jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('ticket.read');

  select * into target from ops.tickets as entry where entry.id = p_ticket_id;

  if not found then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  select coalesce(
    jsonb_agg(ops.ticket_event_json(event.id) order by event.created_at desc, event.id desc),
    '[]'::jsonb
  )
  into timeline
  from (
    select entry.id, entry.created_at
    from ops.ticket_events as entry
    where entry.ticket_id = p_ticket_id
    order by entry.created_at desc, entry.id desc
    limit 50
  ) as event;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'ref_type', reference.ref_type,
        'ref_id', reference.ref_id,
        'created_by', reference.created_by,
        'created_at', reference.created_at
      )
      order by reference.created_at desc, reference.ref_id
    ),
    '[]'::jsonb
  )
  into reference_list
  from ops.ticket_references as reference
  where reference.ticket_id = p_ticket_id;

  return jsonb_build_object(
    'status', 'ok',
    'ticket', ops.ticket_json(p_ticket_id),
    'timeline', timeline,
    'references', reference_list,
    'allowed_actions', ops.allowed_ticket_actions(target.status),
    'assignable_operators', ops.assignable_operators_json(null)
  );
end;
$$;


-- 单条事件的出站形状。`actor` 与工单的 `assignee` 同形（id + display_name + status），
-- 时间线要直接渲染「谁做的」，且售后角色没有 `operator.read`，不能靠二次查询。
CREATE OR REPLACE FUNCTION ops.ticket_event_json (p_event_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', event.id,
    'event_type', event.event_type,
    'from_status', event.from_status,
    'to_status', event.to_status,
    'actor', (
      select jsonb_build_object(
        'id', actor.id,
        'display_name', actor.display_name,
        'status', actor.status
      )
      from ops.operators as actor
      where actor.id = event.actor_id
    ),
    'body', event.body,
    'waiting_on', event.waiting_on,
    'metadata', event.metadata,
    'created_at', event.created_at
  )
  from ops.ticket_events as event
  where event.id = p_event_id;
$$;


-- 时间线分页（契约 §5.6 第七条）。
CREATE OR REPLACE FUNCTION ops.list_ticket_timeline (
  p_ticket_id uuid,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('ticket.read');

  if not exists (select 1 from ops.tickets as entry where entry.id = p_ticket_id) then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  select jsonb_build_object(
    'status', 'ok',
    'total', (
      select count(*) from ops.ticket_events as event where event.ticket_id = p_ticket_id
    ),
    'items', coalesce(
      (
        select jsonb_agg(ops.ticket_event_json(page.id) order by page.created_at desc, page.id desc)
        from (
          select event.id, event.created_at
          from ops.ticket_events as event
          where event.ticket_id = p_ticket_id
          order by event.created_at desc, event.id desc
          limit greatest(coalesce(p_limit, 20), 1)
          offset greatest(coalesce(p_offset, 0), 0)
        ) as page
      ),
      '[]'::jsonb
    )
  )
  into result;

  return result;
end;
$$;


-- 可指派成员列表（契约 §5.6 第二条）。
CREATE OR REPLACE FUNCTION ops.list_assignable_operators (p_keyword text DEFAULT NULL) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('ticket.read');

  return jsonb_build_object(
    'status', 'ok',
    'items', ops.assignable_operators_json(p_keyword)
  );
end;
$$;


-- 创建（契约 §5.6 第三条）。
--
-- 引用的三个可选对象必须属于同一个客户（`REFERENCE_CUSTOMER_MISMATCH`）：工单
-- 挂到别的客户的合同上，售后照着工单去看，会看到一份不相干的合同——而这种错
-- 在列表里完全看不出来（列表只显示客户与主题）。
CREATE OR REPLACE FUNCTION ops.create_ticket (
  p_customer_id uuid,
  p_subject text,
  p_description text,
  p_issue_type text,
  p_priority text,
  p_product_id uuid DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_tenant_mapping_id uuid DEFAULT NULL,
  p_deployment_instance_id uuid DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid;
  reference_customer uuid;
  effective_subject text := nullif(btrim(coalesce(p_subject, '')), '');
  effective_description text := nullif(btrim(coalesce(p_description, '')), '');
  effective_issue_type text := nullif(btrim(coalesce(p_issue_type, '')), '');
begin
  perform ops.require_permission('ticket.create');

  if not exists (select 1 from ops.customers as customer where customer.id = p_customer_id) then
    return jsonb_build_object('status', 'customer_not_found');
  end if;

  if effective_subject is null then
    return jsonb_build_object('status', 'subject_required');
  end if;

  if effective_description is null then
    return jsonb_build_object('status', 'description_required');
  end if;

  if effective_issue_type is null then
    return jsonb_build_object('status', 'issue_type_required');
  end if;

  if p_priority is null or p_priority not in ('urgent', 'high', 'normal', 'low') then
    return jsonb_build_object('status', 'priority_invalid');
  end if;

  if p_product_id is not null and not exists (
    select 1 from ops.products as product where product.id = p_product_id
  ) then
    return jsonb_build_object('status', 'reference_not_found', 'field', 'productId');
  end if;

  if p_contract_id is not null then
    select contract.customer_id
    into reference_customer
    from ops.contracts as contract
    where contract.id = p_contract_id;

    if reference_customer is null then
      return jsonb_build_object('status', 'reference_not_found', 'field', 'contractId');
    end if;

    if reference_customer <> p_customer_id then
      return jsonb_build_object('status', 'reference_customer_mismatch', 'field', 'contractId');
    end if;
  end if;

  -- 两张未落地表的守卫（设计要点 6）：表不存在就跳过，落地后自动开始校验。
  if p_tenant_mapping_id is not null and to_regclass('ops.tenant_mappings') is not null then
    execute $sql$select mapping.customer_id from ops.tenant_mappings as mapping where mapping.id = $1$sql$
    into reference_customer
    using p_tenant_mapping_id;

    if reference_customer is null then
      return jsonb_build_object('status', 'reference_not_found', 'field', 'tenantMappingId');
    end if;

    if reference_customer <> p_customer_id then
      return jsonb_build_object(
        'status', 'reference_customer_mismatch',
        'field', 'tenantMappingId'
      );
    end if;
  end if;

  if p_deployment_instance_id is not null
    and to_regclass('ops.deployment_instances') is not null
  then
    execute $sql$select instance.customer_id from ops.deployment_instances as instance where instance.id = $1$sql$
    into reference_customer
    using p_deployment_instance_id;

    if reference_customer is null then
      return jsonb_build_object('status', 'reference_not_found', 'field', 'deploymentInstanceId');
    end if;

    if reference_customer <> p_customer_id then
      return jsonb_build_object(
        'status', 'reference_customer_mismatch',
        'field', 'deploymentInstanceId'
      );
    end if;
  end if;

  insert into ops.tickets (
    customer_id, product_id, contract_id, tenant_mapping_id, deployment_instance_id,
    subject, description, issue_type, priority, status, due_at, created_by, updated_by
  )
  values (
    p_customer_id,
    p_product_id,
    p_contract_id,
    p_tenant_mapping_id,
    p_deployment_instance_id,
    effective_subject,
    effective_description,
    effective_issue_type,
    p_priority,
    'new',
    ops.ticket_due_at(now()),
    actor_id,
    actor_id
  )
  returning id into new_id;

  perform ops.append_ticket_event(
    new_id,
    'created',
    null,
    'new',
    null,
    null,
    jsonb_build_object('priority', p_priority, 'issueType', effective_issue_type)
  );

  return jsonb_build_object('status', 'ok', 'ticket', ops.ticket_json(new_id));
end;
$$;


-- 编辑（契约 §5.6 第五条）。
--
-- `status` / `assignee` / `resolution` 都不在白名单里：能改状态的 PATCH 等于给
-- 状态机开后门（契约 §7.4 P13 的同一条理由）。NULL 表示「不改」，空字符串在
-- zod 层已被拦下，所以不需要区分「没传」与「传了空」。
CREATE OR REPLACE FUNCTION ops.update_ticket (
  p_ticket_id uuid,
  p_expected_version integer,
  p_subject text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_issue_type text DEFAULT NULL,
  p_priority text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.tickets;
  effective_priority text := nullif(btrim(coalesce(p_priority, '')), '');
begin
  perform ops.require_permission('ticket.update');

  select * into target
  from ops.tickets as entry
  where entry.id = p_ticket_id
  for update;

  if not found then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  if p_expected_version is null or p_expected_version <> target.version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  if effective_priority is not null
    and effective_priority not in ('urgent', 'high', 'normal', 'low')
  then
    return jsonb_build_object('status', 'priority_invalid');
  end if;

  update ops.tickets
  set
    subject = coalesce(nullif(btrim(coalesce(p_subject, '')), ''), subject),
    description = coalesce(nullif(btrim(coalesce(p_description, '')), ''), description),
    issue_type = coalesce(nullif(btrim(coalesce(p_issue_type, '')), ''), issue_type),
    priority = coalesce(effective_priority, priority),
    version = version + 1,
    updated_by = actor_id,
    updated_at = now()
  where id = p_ticket_id;

  return jsonb_build_object('status', 'ok', 'ticket', ops.ticket_json(p_ticket_id));
end;
$$;


-- 分派 / 改派（契约 §5.6 第五条之后的 assign 端点）。
--
-- 状态只从 `new` 前进到 `assigned`；改派（已 assigned / in_progress / waiting）
-- 不改状态——「换个人跟进」不是状态变化，把它记成一次状态迁移会让时间线上出现
-- 两条 assigned，看不出这是第几次换人（换人次数在 metadata 里更清楚）。
CREATE OR REPLACE FUNCTION ops.assign_ticket (
  p_ticket_id uuid,
  p_assignee_operator_id uuid,
  p_expected_version integer,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.tickets;
  assignee ops.operators;
  to_status text;
  event_id uuid;
begin
  perform ops.require_permission('ticket.assign');

  select * into target
  from ops.tickets as entry
  where entry.id = p_ticket_id
  for update;

  if not found then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  if p_expected_version is null or p_expected_version <> target.version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  -- 已关闭的工单不能直接分派（契约 §5.6 的 409）：先 reopen 再派人，
  -- 否则「关闭后又被改了指派」这件事在时间线上会是最后一次动作。
  if target.status = 'closed' then
    return jsonb_build_object(
      'status', 'ticket_closed',
      'allowed_actions', ops.allowed_ticket_actions(target.status)
    );
  end if;

  select * into assignee from ops.operators as operator where operator.id = p_assignee_operator_id;

  if not found then
    return jsonb_build_object('status', 'assignee_not_found');
  end if;

  -- 停用/受邀成员不能接单：分给一个不会看到它的人，是「已分派」的假象。
  if assignee.status <> 'active' then
    return jsonb_build_object('status', 'assignee_inactive', 'assignee_status', assignee.status);
  end if;

  to_status := case when target.status = 'new' then 'assigned' else target.status end;

  update ops.tickets
  set
    assignee_operator_id = p_assignee_operator_id,
    status = to_status,
    version = version + 1,
    updated_by = ops.current_operator_id(),
    updated_at = now()
  where id = p_ticket_id;

  event_id := ops.append_ticket_event(
    p_ticket_id,
    'assigned',
    target.status,
    to_status,
    null,
    null,
    jsonb_strip_nulls(
      jsonb_build_object(
        'assigneeId', p_assignee_operator_id,
        'previousAssigneeId', target.assignee_operator_id,
        'reason', nullif(btrim(coalesce(p_reason, '')), '')
      )
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'ticket', ops.ticket_json(p_ticket_id),
    'event', jsonb_build_object('id', event_id)
  );
end;
$$;


-- 状态迁移（契约 §5.6 第六条）。
--
-- 权限按动作分流：`start` / `wait` / `resume` / `resolve` 要 `ticket.update`，
-- `close` / `reopen` 要 `ticket.close`。售后角色两者都有，但审计与权限矩阵要求
-- 它们可分离——「能处理」与「能关闭」不是同一件事。
CREATE OR REPLACE FUNCTION ops.transition_ticket (
  p_ticket_id uuid,
  p_action text,
  p_expected_version integer,
  p_waiting_on text DEFAULT NULL,
  p_resolution_summary text DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.tickets;
  required_permission text;
  from_status text;
  to_status text;
  event_type text;
  event_body text;
  effective_waiting_on text := nullif(btrim(coalesce(p_waiting_on, '')), '');
  effective_resolution text := nullif(btrim(coalesce(p_resolution_summary, '')), '');
  effective_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  event_id uuid;
begin
  required_permission := case
    when p_action in ('close', 'reopen') then 'ticket.close'
    else 'ticket.update'
  end;

  perform ops.require_permission(required_permission);

  select * into target
  from ops.tickets as entry
  where entry.id = p_ticket_id
  for update;

  if not found then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  if p_expected_version is null or p_expected_version <> target.version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  from_status := target.status;

  to_status := case
    when p_action = 'start' and from_status = 'assigned' then 'in_progress'
    when p_action = 'wait' and from_status = 'in_progress' then 'waiting'
    when p_action = 'resume' and from_status = 'waiting' then 'in_progress'
    when p_action = 'resolve' and from_status in ('in_progress', 'waiting') then 'resolved'
    when p_action = 'close' and from_status = 'resolved' then 'closed'
    when p_action = 'reopen' and from_status in ('resolved', 'closed') then 'in_progress'
  end;

  -- 不存在的边 / 终态 / 词表外的 action 全落这里。带 `allowed_actions` 让前端
  -- 直接按返回渲染按钮，不必自己判断哪条边合法。
  if to_status is null then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current', from_status,
      'action', p_action,
      'allowed_actions', ops.allowed_ticket_actions(from_status)
    );
  end if;

  if p_action = 'wait' and effective_waiting_on is null then
    return jsonb_build_object('status', 'waiting_on_required');
  end if;

  if p_action = 'resolve' and effective_resolution is null then
    return jsonb_build_object('status', 'resolution_summary_required');
  end if;

  if p_action = 'reopen' and effective_reason is null then
    return jsonb_build_object('status', 'reason_required');
  end if;

  event_type := case
    when p_action = 'close' then 'closed'
    when p_action = 'reopen' then 'reopened'
    else 'status_changed'
  end;

  -- 事件正文：resolve 的「处理说明」就是 resolutionSummary（时间线上要看到干了
  -- 什么活）；其余动作用 reason（为什么等 / 为什么重开），没写就留空。
  event_body := case
    when p_action = 'resolve' then effective_resolution
    else effective_reason
  end;

  update ops.tickets
  set
    status = to_status,
    -- 离开 waiting 就清空等待对象（设计要点 5）。
    waiting_on = case when to_status = 'waiting' then effective_waiting_on else null end,
    resolution_summary = case
      when p_action = 'resolve' then effective_resolution
      else resolution_summary
    end,
    closed_at = case when to_status = 'closed' then now() else null end,
    reopen_count = case when p_action = 'reopen' then reopen_count + 1 else reopen_count end,
    version = version + 1,
    updated_by = ops.current_operator_id(),
    updated_at = now()
  where id = p_ticket_id;

  event_id := ops.append_ticket_event(
    p_ticket_id,
    event_type,
    from_status,
    to_status,
    event_body,
    effective_waiting_on,
    jsonb_strip_nulls(
      jsonb_build_object(
        'action', p_action,
        'reason', effective_reason,
        'resolutionSummary', effective_resolution
      )
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'ticket', ops.ticket_json(p_ticket_id),
    'event', jsonb_build_object('id', event_id)
  );
end;
$$;


-- 追加内部说明 / 沟通摘要（契约 §5.6 第八条）。
--
-- `closed` 只允许 reopen（契约的 409 STATE_CONFLICT）：关闭之后再往上贴说明，
-- 等于让一张已归档的工单继续长出新内容，而「关闭时看到了什么」就不再是定论。
CREATE OR REPLACE FUNCTION ops.add_ticket_event (p_ticket_id uuid, p_body text) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.tickets;
  effective_body text := nullif(btrim(coalesce(p_body, '')), '');
  event_id uuid;
begin
  perform ops.require_permission('ticket.update');

  select * into target from ops.tickets as entry where entry.id = p_ticket_id for update;

  if not found then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  if effective_body is null then
    return jsonb_build_object('status', 'body_required');
  end if;

  if target.status = 'closed' then
    return jsonb_build_object(
      'status', 'ticket_closed',
      'allowed_actions', ops.allowed_ticket_actions(target.status)
    );
  end if;

  event_id := ops.append_ticket_event(
    p_ticket_id,
    'comment',
    target.status,
    target.status,
    effective_body,
    null,
    '{}'::jsonb
  );

  -- 加说明不改状态，但要推进 `updated_at`：列表按 updated_at 排序，客户回了
  -- 一句话却还沉在队列底部，是最典型的「工单看起来没人管」。
  update ops.tickets
  set updated_at = now(), updated_by = ops.current_operator_id()
  where id = p_ticket_id;

  return jsonb_build_object(
    'status', 'ok',
    'event', jsonb_build_object('id', event_id, 'event_type', 'comment')
  );
end;
$$;


-- 关联对象（契约 §5.6 第九条）。
--
-- 重复关联返回 `reference_exists`（409 CONFLICT），不靠捕获 unique_violation：
-- 主键冲突会连带把事务标脏，而这里只是一个可预期的业务分支。
CREATE OR REPLACE FUNCTION ops.add_ticket_reference (p_ticket_id uuid, p_ref_type text, p_ref_id uuid) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.tickets;
  reference_exists boolean;
  event_id uuid;
begin
  perform ops.require_permission('ticket.update');

  select * into target from ops.tickets as entry where entry.id = p_ticket_id for update;

  if not found then
    return jsonb_build_object('status', 'ticket_not_found');
  end if;

  if p_ref_type is null
    or p_ref_type not in ('tenant_command', 'entitlement_change', 'deployment_version')
  then
    return jsonb_build_object(
      'status',
      'invalid_ref_type',
      'allowed_ref_types',
      array['tenant_command', 'entitlement_change', 'deployment_version']::text[]
    );
  end if;

  -- 被引用对象是否存在：三张表本轮都不存在（o-t09 / o-t10 / o-t11），
  -- 表不在就跳过，落地后自动开始校验（设计要点 6）。
  if p_ref_type = 'tenant_command' and to_regclass('ops.tenant_commands') is not null then
    execute $sql$select exists (select 1 from ops.tenant_commands as target_row where target_row.id = $1)$sql$
    into reference_exists using p_ref_id;

    if not reference_exists then
      return jsonb_build_object('status', 'reference_not_found');
    end if;
  end if;

  if p_ref_type = 'entitlement_change'
    and to_regclass('ops.entitlement_change_requests') is not null
  then
    execute $sql$select exists (select 1 from ops.entitlement_change_requests as target_row where target_row.id = $1)$sql$
    into reference_exists using p_ref_id;

    if not reference_exists then
      return jsonb_build_object('status', 'reference_not_found');
    end if;
  end if;

  if p_ref_type = 'deployment_version'
    and to_regclass('ops.deployment_version_records') is not null
  then
    execute $sql$select exists (select 1 from ops.deployment_version_records as target_row where target_row.id = $1)$sql$
    into reference_exists using p_ref_id;

    if not reference_exists then
      return jsonb_build_object('status', 'reference_not_found');
    end if;
  end if;

  if exists (
    select 1
    from ops.ticket_references as reference
    where reference.ticket_id = p_ticket_id
      and reference.ref_type = p_ref_type
      and reference.ref_id = p_ref_id
  ) then
    return jsonb_build_object('status', 'reference_exists');
  end if;

  insert into ops.ticket_references (ticket_id, ref_type, ref_id, created_by)
  values (p_ticket_id, p_ref_type, p_ref_id, ops.current_operator_id());

  event_id := ops.append_ticket_event(
    p_ticket_id,
    'linked',
    target.status,
    target.status,
    null,
    null,
    jsonb_build_object('refType', p_ref_type, 'refId', p_ref_id)
  );

  return jsonb_build_object(
    'status', 'ok',
    'reference', jsonb_build_object(
      'ref_type', p_ref_type,
      'ref_id', p_ref_id,
      'created_by', ops.current_operator_id(),
      'created_at', now()
    ),
    'event',
    jsonb_build_object('id', event_id)
  );
end;
$$;


REVOKE ALL ON TABLE ops.tickets,
ops.ticket_events,
ops.ticket_references
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.tickets ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.ticket_events ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.ticket_references ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON SEQUENCE ops.ticket_no_seq
FROM
  public,
  anon,
  authenticated;


-- 内部函数一律连 EXECUTE 也撤：它们只被 SECURITY DEFINER 的兄弟函数调用，
-- 那些函数以 owner 身份运行，不需要经过 authenticated 的权限检查。
-- 留给 authenticated 的后果是多出「能算某状态允许哪些动作」「能列可指派成员」
-- 这类不受 `ticket.read` 约束的入口（与 o-t07 的 `receivable_today` 不同：
-- 那个只是返回一个日期，没有信息量）。
REVOKE ALL ON function ops.business_day_start (date)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allowed_ticket_actions (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.ticket_due_at (timestamptz)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.ticket_is_overdue (text, timestamptz, timestamptz)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.ticket_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.ticket_event_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.assignable_operators_json (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.append_ticket_event (uuid, text, text, text, text, text, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_tickets (
  uuid,
  TEXT[],
  TEXT[],
  uuid,
  uuid,
  date,
  date,
  date,
  boolean,
  boolean,
  integer,
  integer
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_ticket (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_ticket_timeline (uuid, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_assignable_operators (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_ticket (
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  uuid
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.update_ticket (uuid, integer, text, text, text, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.assign_ticket (uuid, uuid, integer, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.transition_ticket (uuid, text, integer, text, text, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.add_ticket_event (uuid, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.add_ticket_reference (uuid, text, uuid)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.list_tickets (
  uuid,
  TEXT[],
  TEXT[],
  uuid,
  uuid,
  date,
  date,
  date,
  boolean,
  boolean,
  integer,
  integer
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_ticket (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_ticket_timeline (uuid, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_assignable_operators (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_ticket (
  uuid,
  text,
  text,
  text,
  text,
  uuid,
  uuid,
  uuid,
  uuid
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_ticket (uuid, integer, text, text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.assign_ticket (uuid, uuid, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_ticket (uuid, text, integer, text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.add_ticket_event (uuid, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.add_ticket_reference (uuid, text, uuid) TO authenticated,
service_role;


COMMENT ON TABLE ops.tickets IS '售后工单（契约 §3.6）。due_at 是创建时按 settings.ticket.dueHours 算出的快照；isOverdue 是派生值不落库。status 只能经 ops.transition_ticket 改。';


COMMENT ON TABLE ops.ticket_events IS '工单时间线，仅 INSERT。actor_id 一律取自会话，不接受入参——可传入的 actor 等于可伪造的时间线。';


COMMENT ON TABLE ops.ticket_references IS '工单关联对象（租户命令 / 授权变更 / 部署版本），主键即去重键，仅 INSERT。';


COMMENT ON function ops.allowed_ticket_actions (text) IS '某工单状态下允许的动作（契约 §3.6）。详情 allowedActions、非法迁移回包、前端按钮三处共用，避免三份状态机副本漂移。';


COMMENT ON function ops.ticket_is_overdue (text, timestamptz, timestamptz) IS '是否逾期：due_at < now 且状态不在 resolved/closed。p_now 显式传入，便于对边界值断言。';


COMMENT ON function ops.ticket_due_at (timestamptz) IS '创建时刻 + settings.ticket.dueHours（缺省 48）。按优先级系数计算属 U-11 未定项，本轮四档同基线。';


COMMENT ON function ops.transition_ticket (uuid, text, integer, text, text, text) IS '工单状态机八条边（契约 §3.6）。close/reopen 要 ticket.close，其余要 ticket.update；非法边回 allowed_actions。';