-- 导出任务（契约 §3.9 `ops.exports`、§5.9 三个端点、T-13 验收断言）。
--
-- 这一域的特殊之处不在 SQL，而在「谁有权拿到里面的数据」：
--
-- 1. **发起时按 `export.create`，取数据时按发起人的域读权限。** 导出是一份
--    落盘的数据，它能被杀掉、被分享、被误发。若只校验 `export.create`，
--    一个有导出权但无 `ticket.read` 的财务就能把工单全表导出去——权限模型里
--    「读某域」这件事就绕开了。所以 `export_fetch_rows` 不认会话身份，只认
--    `exports.requested_by`，按那个人的权限判定。这一条也让「懒执行」成立：
--    触发者是谁不影响结果，只有发起人是谁影响。
--
-- 2. **下载链接按当前请求者的域权限签。** 同一个人可以对另一个人的导出任务
--    有可见性（列表是 `export.read`），但拿不到下载地址（`get_export` 返回
--    `can_download=false`）。这不是「顺手做的过滤」，是上面第 1 条的另一半：
--    数据范围由域权限决定，不由任务归属决定。
--
-- 3. **行数超限就失败，不截断。** 一份静默少了几万行的导出，比一次明确的
--    失败危险得多——看数字的人不会怀疑文件本身。
CREATE SEQUENCE ops.export_no_seq;


CREATE TABLE ops.exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_no text NOT NULL DEFAULT (
    'EXP-' || lpad(nextval('ops.export_no_seq')::text, 6, '0')
  ),
  export_type text NOT NULL CHECK (
    export_type IN (
      'receivables',
      'receipts',
      'contracts',
      'customers',
      'tickets'
    )
  ),
  filters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(filters) = 'object'),
  status text NOT NULL DEFAULT 'queued' CHECK (
    status IN (
      'queued',
      'running',
      'succeeded',
      'failed',
      'expired'
    )
  ),
  requested_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  row_count integer CHECK (
    row_count IS NULL
    OR row_count >= 0
  ),
  storage_path text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT exports_export_no_key UNIQUE (export_no),
  -- `succeeded` 必须有产物与行数。这条不是形状洁癖：`succeeded` 是「这份导出
  -- 存在」的唯一定义，一个 succeeded 而没有 storage_path 的行会让前端渲染出
  -- 一个点不开的下载按钮，而真正的问题（上传那一步没跑）被状态字段盖住。
  CONSTRAINT exports_succeeded_requires_object CHECK (
    status <> 'succeeded'
    OR (
      storage_path IS NOT NULL
      AND row_count IS NOT NULL
    )
  ),
  -- 只有 `succeeded` 与它的后继 `expired` 才有产物：`queued` / `running` /
  -- `failed` 行带上半个文件路径会让「这份导出有没有文件」变成要看状态猜。
  --
  -- `expired` 必须留在这一边，否则「保留期到了」这条 UPDATE 自己会被约束挡住——
  -- 第一版就写成了 `status = 'succeeded'`，pgTAP 的过期扫描一跑就红。约束的
  -- 意思是「谁有产物」，而不是「谁现在还能下载」；后者由 `get_export` 的
  -- `can_download` 与状态判断一起回答。
  CONSTRAINT exports_object_only_when_succeeded CHECK (
    status IN ('succeeded', 'expired')
    OR (
      storage_path IS NULL
      AND row_count IS NULL
    )
  )
);


CREATE INDEX exports_requested_idx ON ops.exports (requested_by, created_at DESC);


-- 懒执行每次都要找「最早的一条 queued」，这条索引就是那个查询的形状。
CREATE INDEX exports_status_created_idx ON ops.exports (status, created_at);


-- 导出类型 → 该域读权限。类型白名单与契约 §5.9 的五个值一一对应；写成函数
-- 而不是在 `export_fetch_rows` 里堆 `case`，因为「下载」与「取数」两处都要它。
CREATE OR REPLACE FUNCTION ops.export_type_permission (export_type text) returns text language sql IMMUTABLE
SET
  search_path = '' AS $$
  select case export_type
    when 'receivables' then 'receivable.read'
    -- 收款列表在库里也是按 `receivable.read` 收口的（`list_receipts` 第一句就是
    -- 它），这里跟着它走。两处口径不同会让「列表看得见、导不出来」成为常态。
    when 'receipts' then 'receivable.read'
    when 'contracts' then 'contract.read'
    when 'customers' then 'customer.read'
    when 'tickets' then 'ticket.read'
  end;
$$;


-- 按**指定账号**判权限，而不是按会话。
--
-- `ops.has_permission` 读 `auth.uid()`，适合「有人在调用」的场景；导出执行是
-- 替发起人办事，当前请求者可能是另一个人（甚至服务端自己）。用会话身份判会
-- 把结果绑到触发者身上：A 发起、B 轮询，B 的权限决定 A 的导出能不能跑。
CREATE OR REPLACE FUNCTION ops.operator_has_permission (p_operator_id uuid, requested_permission text) returns boolean language sql STABLE SECURITY definer
SET
  search_path = '' AS $$
  select exists (
    select 1
    from ops.operators as operator
    join ops.operator_roles as operator_role on operator_role.operator_id = operator.id
    join ops.roles as role on role.id = operator_role.role_id
    join ops.role_permissions as role_permission on role_permission.role_id = role.id
    where operator.id = p_operator_id
      and operator.status = 'active'
      and role.status = 'active'
      and role_permission.permission_code = requested_permission
  );
$$;


-- 单行 → JSON。`requested_by` 是 `{id,displayName}` 对象而不是裸 uuid（U-20），
-- 与 `GET /settings` 的 `updatedBy` 同一理由：列表要直接渲染人名。
CREATE OR REPLACE FUNCTION ops.export_json (entry ops.exports) returns jsonb language sql STABLE
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', entry.id,
    'export_no', entry.export_no,
    'export_type', entry.export_type,
    'filters', entry.filters,
    'status', entry.status,
    'row_count', entry.row_count,
    'storage_path', entry.storage_path,
    'requested_by', (
      select jsonb_build_object('id', operator.id, 'display_name', operator.display_name)
      from ops.operators as operator
      where operator.id = entry.requested_by
    ),
    'created_at', entry.created_at,
    'completed_at', entry.completed_at,
    'expires_at', entry.expires_at
  );
$$;


-- `filters` 里取一组字符串。数组筛选（`status[]`、`priority[]`）在请求里是
-- 数组，在列表函数里是 `text[]`；`null` 与 `[]` 都当「不筛」——这与列表函数
-- 的 `cardinality(p_statuses) = 0` 分支对齐，否则导出的口径会比列表窄一格。
CREATE OR REPLACE FUNCTION ops.export_filter_texts (p_filters jsonb, p_key text) returns TEXT[] language sql IMMUTABLE
SET
  search_path = '' AS $$
  select coalesce(
    (
      select array_agg(value.value)
      from jsonb_array_elements_text(
        case
          when jsonb_typeof(p_filters -> p_key) = 'array' then p_filters -> p_key
          else '[]'::jsonb
        end
      ) as value (value)
    ),
    array[]::text[]
  );
$$;


-- ── 1. 发起 ─────────────────────────────────────────────────────────────────
-- 只写任务行，不取数据：取数据是 `export_fetch_rows` 的事，两者分开是为了让
-- 「发起」这一步能在一次请求里完成（202 的语义），而「跑」可以在任意一次
-- 后续请求里发生。
CREATE OR REPLACE FUNCTION ops.create_export (
  p_export_type text,
  p_filters jsonb DEFAULT '{}'::jsonb,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  operator_id uuid := (select ops.current_operator_id());
  new_entry ops.exports;
  filters_json jsonb := coalesce(p_filters, '{}'::jsonb);
begin
  perform ops.require_permission('export.create');

  if p_export_type is null or p_export_type not in (
    'receivables', 'receipts', 'contracts', 'customers', 'tickets'
  ) then
    return jsonb_build_object('status', 'unsupported_type', 'export_type', p_export_type);
  end if;

  -- 原因必填（U-17）。`trim` 之后再判：一个空格不算理由，而它会让审计里
  -- 的 `reason` 看起来「有值」，从而躲过「这次导出没说为什么」的追问。
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if jsonb_typeof(filters_json) <> 'object' then
    return jsonb_build_object('status', 'invalid_filters');
  end if;

  insert into ops.exports (export_type, filters, requested_by)
  values (p_export_type, filters_json, operator_id)
  returning * into new_entry;

  perform ops.write_audit(
    'export.created',
    'export',
    new_entry.id,
    p_reason,
    NULL,
    jsonb_build_object(
      'exportNo', new_entry.export_no,
      'exportType', new_entry.export_type,
      'filters', filters_json,
      'status', new_entry.status
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'export', jsonb_build_object(
      'id', new_entry.id,
      'export_no', new_entry.export_no,
      'export_type', new_entry.export_type,
      'status', new_entry.status
    )
  );
end;
$$;


-- ── 2. 列表 ─────────────────────────────────────────────────────────────────
-- 顺带把到期的产物标成 `expired`：保留期是「读的时候才有人知道它过期了」的
-- 东西，没有定时任务的本地栈与刚部署的线上都一样，所以不指望后台清扫。
CREATE OR REPLACE FUNCTION ops.list_exports (
  p_export_type text DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_requested_by uuid DEFAULT NULL
) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  items jsonb;
begin
  perform ops.require_permission('export.read');

  update ops.exports as entry
  set status = 'expired'
  where entry.status = 'succeeded'
    and entry.expires_at is not null
    and entry.expires_at < now();

  -- 排序加 `export_no` 作次级键：同一事务里 `now()` 是恒定的（Postgres 的
  -- `now()` 返回事务开始时间），只按 `created_at` 排会让「最早的一条」在同事务
  -- 写入的多行之间变成任意顺序。生产里每行一个事务，看不出差别；测试里这是
  -- 「断言时灵时不灵」的来源。
  select coalesce(
    jsonb_agg(ops.export_json(entry) order by entry.created_at desc, entry.export_no desc),
    '[]'::jsonb
  )
  into items
  from ops.exports as entry
  where (p_export_type is null or entry.export_type = p_export_type)
    and (
      p_statuses is null
      or cardinality(p_statuses) = 0
      or entry.status = any (p_statuses)
    )
    and (p_requested_by is null or entry.requested_by = p_requested_by);

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;


-- ── 3. 详情 ─────────────────────────────────────────────────────────────────
-- `can_download` 是当前请求者对**这类数据**的读权限，与任务归属无关。
-- 契约 §5.9 把 `downloadUrl` 写成可选字段，这个布尔就是「可选」的依据；
-- 把它放在服务端算，前端就不必自己拼一套权限判断（那必然会与库里分叉）。
CREATE OR REPLACE FUNCTION ops.get_export (p_export_id uuid) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  entry ops.exports;
begin
  perform ops.require_permission('export.read');

  update ops.exports as row
  set status = 'expired'
  where row.id = p_export_id
    and row.status = 'succeeded'
    and row.expires_at is not null
    and row.expires_at < now();

  select * into entry from ops.exports where id = p_export_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'export', ops.export_json(entry),
    'can_download', (select ops.has_permission(ops.export_type_permission(entry.export_type)))
  );
end;
$$;


-- ── 4. 认领一条待办 ─────────────────────────────────────────────────────────
-- 两件事：把超出租约的 `running` 放回队列，取最早的一条 queued 改成 running。
--
-- 租约借用 `expires_at`：运行中这一列没有别的用处（前端只在 succeeded 时展示），
-- 而加一列 `started_at` 只为记一个「可能卡住的开始时间」不划算。代价是
-- `running` 行的 `expires_at` 是租约而不是产物过期时间——所以它必须在
-- `finish_export` 里被改写，否则一份刚成功的导出会立刻显示「已过期」。
--
-- 不加租约的后果不是理论上的：API 进程在上传文件时被重启，那一行会永远
-- `running`，而它既不会被重试也不会被标失败，前端会一直转圈。
CREATE OR REPLACE FUNCTION ops.claim_export () returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  entry ops.exports;
begin
  perform ops.require_permission('export.read');

  update ops.exports as stale
  set status = 'queued', expires_at = NULL
  where stale.status = 'running'
    and stale.expires_at is not null
    and stale.expires_at < now();

  update ops.exports as candidate
  set status = 'running', expires_at = now() + interval '10 minutes'
  where candidate.id = (
    select queued.id
    from ops.exports as queued
    where queued.status = 'queued'
    order by queued.created_at, queued.export_no
    limit 1
    for update skip locked
  )
  returning * into entry;

  if entry.id is null then
    return jsonb_build_object('status', 'empty');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'export', jsonb_build_object(
      'id', entry.id,
      'export_no', entry.export_no,
      'export_type', entry.export_type,
      'filters', entry.filters,
      'status', entry.status,
      'requested_by', entry.requested_by
    )
  );
end;
$$;


-- ── 5. 取数 ─────────────────────────────────────────────────────────────────
-- 复用各域列表函数的**同一份筛选 SQL**，而不是另写一套 where。
--
-- 这是这一域最重要的一条：导出与列表口径分叉过一次就再也对不上，而且错法是
-- 「导出的行数比列表少两行」这种没人会立刻发现的样子。代价是导出受列表函数
-- 的分页上限约束——`list_contracts` / `list_customers` 把 page_size 钳到 100，
-- 所以这里逐页循环；`list_receivables` / `list_receipts` / `list_tickets` 用
-- limit/offset，循环方式一致。
--
-- 行数上限 100000 与契约 §10.1 的压测规模对齐。超了就回 `too_many_rows` 让
-- 任务失败——静默截断的导出会被当成全量使用。
--
-- **取数要在发起人的身份下跑，不是触发者的。**
--
-- 今天这一层切换**不改变任何输出**，这一点必须写清楚，否则下一个人会以为它
-- 是可观测的行为：五个域的列表函数里没有一个按会话分支（`has_permission` 只
-- 出现在 customers 域的写与详情路径上），而 `customer_list_json` 的
-- `primary_contact` 恒为 `masked_phone` / `masked_email`——原值根本不在列表
-- 回包里。所以「以谁的身份取数」目前是同一个结果。
--
-- 保留它是因为它是**结构保证**而不是当下的巧合：`get_customer` 有一条
-- `sensitive` 分支，一旦有人把列表也接上（比如「列表给原值」），以触发者身份
-- 取数就会让「有敏感权限的人替别人跑一次」变成一次数据泄漏，而权限门
-- （`operator_has_permission(requested_by, …)`）仍然是过的——门是开的、数据是
-- 多的、日志是干净的，这是最难查的一种。
--
-- 代价是 pgTAP 里没有断言守着它：任何「断言没变」的测试在两种实现下都是绿的。
-- 与其写一条恒真的假断言，不如把这件事写在这里。
CREATE OR REPLACE FUNCTION ops.export_rows_for (p_export_type text, p_filters jsonb) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  page_size integer := 500;
  max_rows integer := 100000;
  fetched jsonb := '[]'::jsonb;
  batch jsonb;
  batch_rows integer;
  total_rows integer := 0;
  offset_value integer := 0;
  page_index integer := 1;
begin
  -- 五个域的参数映射。`filters` 与列表端点的 query 同构（camelCase），
  -- 所以这里只做「键名 → 位置参数」，不做值转换以外的判断——所有取值合法性
  -- 由列表函数自己判定（非法值等价于筛不出东西，与列表行为一致）。
  --
  -- **排序与分页词一律忽略**：导出是一份全量文件，顺序由服务端定（列表默认
  -- 顺序）。让 `filters` 决定排序会把 API 层的 sort 白名单映射复制一份到 SQL
  -- 里（`createdAt` → `created_at`），那是第二真源；而 CSV 的使用者本来就会
  -- 自己排。
  if p_export_type = 'receivables' then
    loop
      batch := ops.list_receivables(
        (p_filters ->> 'customerId')::uuid,
        (p_filters ->> 'contractId')::uuid,
        nullif(ops.export_filter_texts(p_filters, 'status'), array[]::text[]),
        (p_filters ->> 'dueFrom')::date,
        (p_filters ->> 'dueTo')::date,
        coalesce((p_filters ->> 'overdueOnly')::boolean, false),
        'due_date',
        false,
        page_size,
        offset_value
      );
      batch_rows := jsonb_array_length(batch -> 'items');
      fetched := fetched || (batch -> 'items');
      total_rows := total_rows + batch_rows;
      offset_value := offset_value + page_size;
      exit when batch_rows < page_size or total_rows > max_rows;
    end loop;

  elsif p_export_type = 'receipts' then
    loop
      batch := ops.list_receipts(
        (p_filters ->> 'customerId')::uuid,
        (p_filters ->> 'contractId')::uuid,
        nullif(ops.export_filter_texts(p_filters, 'status'), array[]::text[]),
        p_filters ->> 'methodCode',
        (p_filters ->> 'dateFrom')::date,
        (p_filters ->> 'dateTo')::date,
        page_size,
        offset_value
      );
      batch_rows := jsonb_array_length(batch -> 'items');
      fetched := fetched || (batch -> 'items');
      total_rows := total_rows + batch_rows;
      offset_value := offset_value + page_size;
      exit when batch_rows < page_size or total_rows > max_rows;
    end loop;

  elsif p_export_type = 'tickets' then
    loop
      batch := ops.list_tickets(
        (p_filters ->> 'customerId')::uuid,
        nullif(ops.export_filter_texts(p_filters, 'status'), array[]::text[]),
        nullif(ops.export_filter_texts(p_filters, 'priority'), array[]::text[]),
        (p_filters ->> 'assigneeOperatorId')::uuid,
        (p_filters ->> 'productId')::uuid,
        (p_filters ->> 'updatedFrom')::date,
        (p_filters ->> 'createdFrom')::date,
        (p_filters ->> 'createdTo')::date,
        coalesce((p_filters ->> 'unassigned')::boolean, false),
        coalesce((p_filters ->> 'overdueOnly')::boolean, false),
        page_size,
        offset_value
      );
      batch_rows := jsonb_array_length(batch -> 'items');
      fetched := fetched || (batch -> 'items');
      total_rows := total_rows + batch_rows;
      offset_value := offset_value + page_size;
      exit when batch_rows < page_size or total_rows > max_rows;
    end loop;

  elsif p_export_type = 'contracts' then
    loop
      batch := ops.list_contracts(
        p_filters ->> 'keyword',
        (p_filters ->> 'customerId')::uuid,
        nullif(ops.export_filter_texts(p_filters, 'status'), array[]::text[]),
        (p_filters ->> 'ownerOperatorId')::uuid,
        (p_filters ->> 'expiresFrom')::date,
        (p_filters ->> 'expiresTo')::date,
        p_filters ->> 'salesMode',
        page_index,
        page_size
      );
      batch_rows := jsonb_array_length(batch -> 'items');
      fetched := fetched || (batch -> 'items');
      total_rows := total_rows + batch_rows;
      page_index := page_index + 1;
      exit when batch_rows < least(page_size, 100) or total_rows > max_rows;
    end loop;

  else
    loop
      batch := ops.list_customers(
        p_filters ->> 'keyword',
        nullif(ops.export_filter_texts(p_filters, 'status'), array[]::text[]),
        (p_filters ->> 'ownerOperatorId')::uuid,
        p_filters ->> 'contractStatus',
        (p_filters ->> 'entitlementExpiringInDays')::integer,
        'created_at',
        'desc',
        page_index,
        page_size
      );
      batch_rows := jsonb_array_length(batch -> 'items');
      fetched := fetched || (batch -> 'items');
      total_rows := total_rows + batch_rows;
      page_index := page_index + 1;
      exit when batch_rows < least(page_size, 100) or total_rows > max_rows;
    end loop;
  end if;

  if total_rows > max_rows then
    return jsonb_build_object(
      'status', 'too_many_rows',
      'row_limit', max_rows,
      'row_count', total_rows
    );
  end if;

  return jsonb_build_object('status', 'ok', 'row_count', total_rows, 'rows', fetched);
end;
$$;


-- 取数的对外入口：判权限 → 切到发起人身份 → 调上面那个 → 恢复身份。
--
-- 身份切换用 `set_config('request.jwt.claims', …, true)`（事务级），只影响这一次
-- RPC。PostgREST 每个 RPC 一个事务，所以它不会漏到下一个请求；但 pgTAP 是在一个
-- 大事务里跑的，所以末尾必须恢复——否则后面所有断言的 `auth.uid()` 都变成发起人。
-- 恢复写在 `exception` 分支里同样重要：不恢复就直接 return，返回时的身份错误会
-- 变成「下一条断言莫名其妙失败」。
CREATE OR REPLACE FUNCTION ops.export_fetch_rows (p_export_id uuid) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  entry ops.exports;
  required_permission text;
  requester_user_id uuid;
  original_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  outcome jsonb;
begin
  select * into entry from ops.exports where id = p_export_id;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if entry.status <> 'running' then
    return jsonb_build_object('status', 'not_running', 'current_status', entry.status);
  end if;

  -- 先显式判一次：让「发起人已被撤权」回一个 `forbidden` 信封，而不是让
  -- `list_*` 内部的 `require_permission` 抛 42501。异常和信封在这里的区别是
  -- 「这条任务能不能被标记失败」——信封能，异常会把整次执行变成 503。
  required_permission := ops.export_type_permission(entry.export_type);
  if required_permission is null
    or not (select ops.operator_has_permission(entry.requested_by, required_permission)) then
    return jsonb_build_object('status', 'forbidden', 'required_permission', required_permission);
  end if;

  select operator.user_id into requester_user_id
  from ops.operators as operator
  where operator.id = entry.requested_by;

  begin
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', requester_user_id, 'role', 'authenticated')::text,
      true
    );
    outcome := ops.export_rows_for(entry.export_type, entry.filters);
  exception
    when others then
      perform set_config('request.jwt.claims', original_claims, true);
      raise;
  end;

  perform set_config('request.jwt.claims', original_claims, true);

  return outcome;
end;
$$;


-- ── 6. 收尾三条 ─────────────────────────────────────────────────────────────
-- 成功：状态 + 产物 + 过期时间一次写完（表上的 CHECK 要求它们同时成立）。
--
-- `expires_at` 由**库**算，不由调用方传：保留期是 `settings.retention.exportDays`
-- 的函数，而执行导出的 Node 侧不一定有 `settings.manage`（它只是恰好触发了
-- 一次列表请求）。让调用方传过期时间，等于把「保留多久」这项设置交给了每次
-- 调用的心情；更糟的是它会把 `PATCH /settings` 与已有导出割裂——改设置之后
-- 新导出的保留期才变，而这条本该自动成立。
CREATE OR REPLACE FUNCTION ops.finish_export (
  p_export_id uuid,
  p_row_count integer,
  p_storage_path text,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  entry ops.exports;
  retention_days integer := ops.setting_int('retention.exportDays', 90);
begin
  update ops.exports as row
  set
    status = 'succeeded',
    row_count = p_row_count,
    storage_path = p_storage_path,
    expires_at = now() + make_interval(days => greatest(coalesce(retention_days, 90), 1)),
    completed_at = now()
  where row.id = p_export_id
    and row.status = 'running'
  returning * into entry;

  if entry.id is null then
    return jsonb_build_object('status', 'not_running');
  end if;

  -- 摘要带 filters 与 rowCount：T-13 要求「导出审计含 filters 与 rowCount」，
  -- 而创建时还不可能知道行数，所以这件事只能由完成时的这一条来补。
  perform ops.write_audit(
    'export.completed',
    'export',
    entry.id,
    NULL,
    NULL,
    jsonb_build_object(
      'exportNo', entry.export_no,
      'exportType', entry.export_type,
      'filters', entry.filters,
      'rowCount', entry.row_count,
      'status', entry.status
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'export', ops.export_json(entry));
end;
$$;


-- 失败：不写 `row_count` / `storage_path`（表上的第二条 CHECK 会拦），原因进审计。
--
-- `ops.exports` 没有 `failure_reason` 列——契约 §3.9 的列清单里没有它。所以
-- 「为什么失败」只存在于审计的 `after_summary.reason` 与 API 日志里；这是有意的
-- 取舍：多一列就是一张契约外的表，而失败原因不需要被列表查询。
CREATE OR REPLACE FUNCTION ops.abort_export (
  p_export_id uuid,
  p_reason text,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  entry ops.exports;
begin
  update ops.exports as row
  set status = 'failed', completed_at = now(), expires_at = NULL
  where row.id = p_export_id
    and row.status = 'running'
  returning * into entry;

  if entry.id is null then
    return jsonb_build_object('status', 'not_running');
  end if;

  perform ops.write_audit(
    'export.failed',
    'export',
    entry.id,
    p_reason,
    NULL,
    jsonb_build_object(
      'exportNo', entry.export_no,
      'exportType', entry.export_type,
      'filters', entry.filters,
      'reason', p_reason,
      'status', entry.status
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok');
end;
$$;


-- 过期扫描单独开一个入口：`GET /exports` 与 `GET /exports/{id}` 已经在读的时候
-- 顺手扫了，但一个只看列表第一页的人不会碰到第 30 页那些过期行。保留期到了
-- 就该在**任何一次**导出页访问时被清算，而不是等某个人点开那一行。
CREATE OR REPLACE FUNCTION ops.expire_exports () returns jsonb language plpgsql SECURITY definer
SET
  search_path = '' AS $$
declare
  affected integer;
begin
  perform ops.require_permission('export.read');

  update ops.exports as row
  set status = 'expired'
  where row.status = 'succeeded'
    and row.expires_at is not null
    and row.expires_at < now();

  get diagnostics affected = row_count;
  return jsonb_build_object('status', 'ok', 'expired', affected);
end;
$$;


-- ── 7. 授权 ────────────────────────────────────────────────────────────────
-- 契约 §7.3 把 `exports` 归在 A2（只能经 RPC）：表零直写零直读，全部走函数。
REVOKE ALL ON TABLE ops.exports
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.exports enable ROW level security;


REVOKE ALL ON SEQUENCE ops.export_no_seq
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.export_type_permission (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.operator_has_permission (uuid, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.export_json (ops.exports)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.export_filter_texts (jsonb, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_export (text, jsonb, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_exports (text, TEXT[], uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.get_export (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.claim_export ()
FROM
  public,
  anon;


-- 取数体不给任何客户端角色：它不判权限，只负责在「已经确认过的身份」下取行。
-- 会碰它的只有 `export_fetch_rows`（definer，owner 与它相同），因此也不需要 GRANT。
REVOKE ALL ON function ops.export_rows_for (text, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.export_fetch_rows (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.finish_export (uuid, integer, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.abort_export (uuid, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.expire_exports ()
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.operator_has_permission (uuid, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_export (text, jsonb, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_exports (text, TEXT[], uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_export (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.claim_export () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.export_fetch_rows (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.finish_export (uuid, integer, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.abort_export (uuid, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.expire_exports () TO authenticated,
service_role;


COMMENT ON TABLE ops.exports IS '导出任务（契约 §3.9）。`succeeded` 必有 storage_path 与 row_count；failed 的原因只在审计里。';


COMMENT ON FUNCTION ops.create_export (text, jsonb, text, text) IS '发起导出（契约 §5.9 POST /exports）：写任务行 + 审计 export.created，不取数据。reason 必填（U-17）。';


COMMENT ON FUNCTION ops.claim_export () IS '认领最早的一条 queued 并置 running，租约 10 分钟（借 expires_at）。租约到期的 running 会被放回队列。';


COMMENT ON FUNCTION ops.export_fetch_rows (uuid) IS '取导出行：判发起人域读权限、临时切到发起人身份（含敏感字段脱敏口径）后调 export_rows_for，超 100000 行回 too_many_rows。';


COMMENT ON FUNCTION ops.get_export (uuid) IS '导出详情（契约 §5.9）。can_download 是当前请求者对该域的读权限，与任务归属无关。';


COMMENT ON FUNCTION ops.export_type_permission (text) IS '导出类型 → 域读权限。收款按 receivable.read（与 list_receipts 同口径）。';