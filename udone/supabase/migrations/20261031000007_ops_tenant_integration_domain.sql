-- 运营 tenant-integration 域：三张表 + 二十二个函数（契约 §3.6、§5.7 十个端点）。
--
-- 本域要回答的问题只有一个：**运营侧说「客户已经开通了」，凭什么算数？**
-- 答案是「不凭什么」——本地状态只是意图，远端确认才算数。三张表把这句话
-- 拆成三层：
--
--   tenant_mappings          我们以为的租户（含一个 sync_version）
--   tenant_commands          想让它变成什么（幂等键 + 期望版本 + 原因）
--   tenant_command_attempts  每次真的去说的结果（只 INSERT）
--
-- 1. **`udone_organization_id` 必须可空，尽管契约 §3.6 写的是 `NOT NULL`。**
--    同一节的 §5.7 把创建时的这个字段标成 `?`，PATCH 又规定「非 `pending`
--    禁止改外部 ID」——只有「创建时可能还没有、pending 期间补上」这一种读法
--    能让三处同时成立。而且这正是主流程：`provision` 命令存在的意义就是租户
--    还不存在、org id 得由远端回填。若按 `NOT NULL` 实现，第一次开通就必须
--    先知道还不存在的那个 id。这处列定义与 §3.6 的偏差登记为 C-117。
--
-- 2. **`UNIQUE(customer_id, product_id, udone_organization_id)` 没有建。**
--    它是冗余的：`UNIQUE(udone_organization_id)` 已经更强——org id 全局不重复，
--    三元组自然不可能重复。契约列它大概是想强调「一个租户只能指向一个商业
--    客户」，那句话的真正落点是第一条唯一索引。多建一条只会多一个写放大。
--
-- 3. **`sync_version` 只在「下发成功」时 +1，而且只在映射上。** 它是乐观锁的
--    那一半：运营端读到一个版本，提交命令时带上它，远端确认后版本前进。
--    失败、超时、取消都**不动**它——版本表达的是「远端现在是什么样」，
--    不是「我们试过几次」。尝试次数在 `attempt_count` 里，两者混用会让
--    「重试了三次才成功」看起来像「远端被改了三次」。
--
-- 4. **202 的含义靠「谁能把命令推进终态」来保证。** 运营端只能 `create`、
--    `retry`、`cancel`；把 `pending` 变成 `succeeded`/`failed` 的
--    `record_tenant_command_attempt` **不授给 `authenticated`**，只给
--    `service_role`。否则任何有 `tenant.provision` 的人可以直接调一次
--    「下发成功」，把本地状态刷成开通——那正是 PRD §6.7 要防的
--    「同步失败不得把运营侧状态改成成功」。
--
-- 5. **`timeout` 不结束命令。** 契约 §3.6 写 `pending --timeout--> pending`
--    （结果未知），并要求「超时先查询远端状态再重试」。所以超时只加一条
--    attempt、推后 `next_retry_at`，状态留在 `pending`（若原来是 `retrying`
--    则退回 `pending`）。把它当失败会让「远端其实办成了」的请求被重发，
--    而 `provision` 不是幂等的。
--
-- 6. **`cancel` 只在「一次都没发出去过」时才允许**（`attempt_count = 0`）。
--    发出去过就不能取消——远端可能已经受理，本地标 `cancelled` 等于假装
--    它没发生。已经发出的想收回来，走 `revoke` 命令，那是一次新的下发。
--
-- 7. **权限按 `command_type` 判，不按端点判。** 一个创建命令的端点承载八种
--    命令、三类权限（`provision`/`bind`/`activate`→`tenant.provision`；
--    `suspend`→`tenant.suspend`；`resume`→`tenant.restore`；
--    `sync_entitlement`/`extend`/`revoke`→`entitlement.execute`）。
--    与 o-t09 的 transition 同构：端点级固定判一个权限时，`suspend` 会被
--    `tenant.provision` 放行，而 `sync_entitlement` 会被挡成 403，两种错都不报错。
--
-- 8. **真正的下发没有做。** 本轮只有台账：命令怎么建、怎么重试、怎么取消、
--    结果怎么记。没有 HTTP 客户端、没有调度器、没有「超时后先查远端再重试」
--    的那次查询——`record_tenant_command_attempt` 由谁调、什么时候调，属于
--    下一个单元。这一点必须说清楚：**验收能证明「状态机不许伪造成功」，
--    不能证明「命令真的发出去了」**（C-118）。
-- ── 1. 序列与表 ────────────────────────────────────────────────────────────
CREATE SEQUENCE ops.tenant_mapping_no_seq AS bigint START
WITH
  1;


CREATE SEQUENCE ops.tenant_command_no_seq AS bigint START
WITH
  1;


CREATE TABLE ops.tenant_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_no text NOT NULL DEFAULT (
    'TM-' || lpad(
      nextval('ops.tenant_mapping_no_seq')::text,
      6,
      '0'
    )
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES ops.products (id) ON DELETE RESTRICT,
  -- 外部 ID（udone 的组织）。可空是刻意的，见设计要点 1。
  udone_organization_id uuid,
  external_ref text,
  mapping_status text NOT NULL DEFAULT 'pending' CHECK (
    mapping_status IN ('pending', 'active', 'suspended', 'terminated')
  ),
  last_known_state text,
  last_synced_at timestamptz,
  sync_version integer NOT NULL DEFAULT 0 CHECK (sync_version >= 0),
  version integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_mappings_mapping_no_key UNIQUE (mapping_no),
  -- 契约 §3.6「一个租户只能指向一个商业客户」。NULL 之间互不冲突，
  -- 所以多条「还没绑定的 pending 映射」可以并存——它们什么都还没指向。
  CONSTRAINT tenant_mappings_organization_key UNIQUE (udone_organization_id),
  CONSTRAINT tenant_mappings_external_ref_check CHECK (
    external_ref IS NULL
    OR length(btrim(external_ref)) > 0
  )
);


CREATE INDEX tenant_mappings_customer_idx ON ops.tenant_mappings (customer_id, created_at DESC);


CREATE INDEX tenant_mappings_status_idx ON ops.tenant_mappings (mapping_status, created_at DESC);


CREATE TABLE ops.tenant_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_no text NOT NULL DEFAULT (
    'CMD-' || lpad(
      nextval('ops.tenant_command_no_seq')::text,
      6,
      '0'
    )
  ),
  -- 契约 §3.6 要求幂等键是列而不是只靠中间件：同一把键重放同一件事，
  -- 换一件事来重放就是冲突。判定在 create_tenant_command 里（设计要点 4 的反面）。
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  mapping_id uuid REFERENCES ops.tenant_mappings (id) ON DELETE RESTRICT,
  command_type text NOT NULL CHECK (
    command_type IN (
      'provision',
      'bind',
      'activate',
      'suspend',
      'resume',
      'sync_entitlement',
      'extend',
      'revoke'
    )
  ),
  customer_id uuid REFERENCES ops.customers (id) ON DELETE RESTRICT,
  contract_id uuid REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  change_request_id uuid REFERENCES ops.entitlement_change_requests (id) ON DELETE RESTRICT,
  expected_sync_version integer CHECK (
    expected_sync_version IS NULL
    OR expected_sync_version >= 0
  ),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN (
      'pending',
      'retrying',
      'succeeded',
      'failed',
      'cancelled'
    )
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text,
  last_error_category text CHECK (
    last_error_category IS NULL
    OR last_error_category IN (
      'transient',
      'permanent',
      'auth',
      'conflict',
      'unknown'
    )
  ),
  request_summary jsonb,
  response_summary jsonb,
  request_id text,
  next_retry_at timestamptz,
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 0,
  CONSTRAINT tenant_commands_command_no_key UNIQUE (command_no),
  CONSTRAINT tenant_commands_idempotency_key_key UNIQUE (idempotency_key),
  -- 契约 §3.6：`permanent` 禁止重试。放在表上是为了让「绕过端点的重试」也拦得住。
  CONSTRAINT tenant_commands_permanent_retry_check CHECK (
    status <> 'retrying'
    OR last_error_category IS DISTINCT FROM 'permanent'
  ),
  -- 终态与结束时间同真同假。pending/retrying 有 end 时间 = 「结束了但还是待办」，
  -- 这种行会让「待办命令」这个列表永远清不掉。
  CONSTRAINT tenant_commands_completed_check CHECK (
    (status IN ('succeeded', 'failed', 'cancelled')) = (completed_at IS NOT NULL)
  )
);


CREATE INDEX tenant_commands_status_idx ON ops.tenant_commands (status, created_at);


CREATE INDEX tenant_commands_mapping_idx ON ops.tenant_commands (mapping_id, created_at DESC);


CREATE INDEX tenant_commands_next_retry_idx ON ops.tenant_commands (next_retry_at)
WHERE
  status IN ('pending', 'retrying');


CREATE TABLE ops.tenant_command_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL REFERENCES ops.tenant_commands (id) ON DELETE RESTRICT,
  attempt_no integer NOT NULL CHECK (attempt_no >= 1),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'timeout')),
  http_status integer,
  error_category text CHECK (
    error_category IS NULL
    OR error_category IN (
      'transient',
      'permanent',
      'auth',
      'conflict',
      'unknown'
    )
  ),
  request_id text,
  response_summary jsonb,
  actor_id uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT tenant_command_attempts_no_key UNIQUE (command_id, attempt_no),
  -- 成功的那次不该带着错误分类。两个字段并存时，读的人不知道该信哪个。
  CONSTRAINT tenant_command_attempts_success_check CHECK (
    outcome <> 'succeeded'
    OR error_category IS NULL
  )
);


CREATE INDEX tenant_command_attempts_command_idx ON ops.tenant_command_attempts (command_id, attempt_no DESC);


-- 尝试记录只 INSERT。契约 §3.6 只写「仅 INSERT」，但和快照一样，只靠 REVOKE
-- 挡不住表属主——而「这次下发其实失败了」被改成成功，是这一域唯一值得篡改的东西。
CREATE OR REPLACE FUNCTION ops.tenant_command_attempt_immutable () returns trigger language plpgsql
SET
  search_path = '' AS $$
begin
  raise exception 'ops tenant command attempts are append-only' using errcode = 'restrict_violation';
end;
$$;


CREATE TRIGGER tenant_command_attempts_immutable
BEFORE UPDATE OR DELETE ON ops.tenant_command_attempts FOR EACH ROW
EXECUTE FUNCTION ops.tenant_command_attempt_immutable ();


-- ── 2. 状态机与权限映射（契约 §3.6）────────────────────────────────────────
-- 只有两个动作对运营端开放：`cancel`（一次都没发出去）与 `retry`（失败且非永久）。
-- 其余的边（dispatch_success / dispatch_fail_* / timeout）由系统侧走
-- `record_tenant_command_attempt`，不在 allowed_command_actions 里。
CREATE OR REPLACE FUNCTION ops.allowed_command_actions (p_status text) returns TEXT[] language sql immutable
SET
  search_path = '' AS $$
  select case p_status
    when 'pending' then array['cancel']
    when 'failed' then array['retry']
    else array[]::text[]
  end;
$$;


CREATE OR REPLACE FUNCTION ops.command_required_permission (p_command_type text) returns text language sql immutable
SET
  search_path = '' AS $$
  select case p_command_type
    when 'provision' then 'tenant.provision'
    when 'bind' then 'tenant.provision'
    when 'activate' then 'tenant.provision'
    when 'suspend' then 'tenant.suspend'
    when 'resume' then 'tenant.restore'
    when 'sync_entitlement' then 'entitlement.execute'
    when 'extend' then 'entitlement.execute'
    when 'revoke' then 'entitlement.execute'
    else null
  end;
$$;


-- 指数退避：2^attempt 分钟，封顶 60。第一次失败等 2 分钟、第二次 4 分钟……
-- 封顶是必须的：远端维护一小时，第 10 次重试若等 1024 分钟，这条命令在
-- `next_retry_at` 上就变成一个「明天再说」的黑洞。
CREATE OR REPLACE FUNCTION ops.tenant_retry_backoff (p_attempt_count integer) returns interval language sql immutable
SET
  search_path = '' AS $$
  select make_interval(mins => least((power(2, greatest(coalesce(p_attempt_count, 0), 0)))::integer, 60));
$$;


-- ── 3. 出站形状 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.tenant_mapping_json (p_mapping_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', entry.id,
    'mapping_no', entry.mapping_no,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name
    ),
    'product', jsonb_build_object(
      'id', product.id,
      'code', product.code,
      'name', product.name
    ),
    'udone_organization_id', entry.udone_organization_id,
    'external_ref', entry.external_ref,
    'mapping_status', entry.mapping_status,
    'last_known_state', entry.last_known_state,
    'last_synced_at', entry.last_synced_at,
    'sync_version', entry.sync_version,
    'version', entry.version,
    'created_at', entry.created_at,
    'updated_at', entry.updated_at
  )
  into result
  from ops.tenant_mappings as entry
  join ops.customers as customer on customer.id = entry.customer_id
  join ops.products as product on product.id = entry.product_id
  where entry.id = p_mapping_id;

  return result;
end;
$$;


CREATE OR REPLACE FUNCTION ops.tenant_command_json (p_command_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', entry.id,
    'command_no', entry.command_no,
    'mapping_id', entry.mapping_id,
    'command_type', entry.command_type,
    'customer_id', entry.customer_id,
    'contract_id', entry.contract_id,
    'change_request_id', entry.change_request_id,
    'expected_sync_version', entry.expected_sync_version,
    'reason', entry.reason,
    'status', entry.status,
    'attempt_count', entry.attempt_count,
    'last_error_code', entry.last_error_code,
    'last_error_category', entry.last_error_category,
    'request_summary', entry.request_summary,
    'response_summary', entry.response_summary,
    'request_id', entry.request_id,
    'next_retry_at', entry.next_retry_at,
    'created_by', entry.created_by,
    'created_at', entry.created_at,
    'completed_at', entry.completed_at,
    'version', entry.version
  )
  into result
  from ops.tenant_commands as entry
  where entry.id = p_command_id;

  return result;
end;
$$;


CREATE OR REPLACE FUNCTION ops.tenant_attempt_json (p_attempt_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', entry.id,
    'command_id', entry.command_id,
    'attempt_no', entry.attempt_no,
    'started_at', entry.started_at,
    'finished_at', entry.finished_at,
    'outcome', entry.outcome,
    'http_status', entry.http_status,
    'error_category', entry.error_category,
    'request_id', entry.request_id,
    'response_summary', entry.response_summary,
    'actor_id', entry.actor_id
  )
  into result
  from ops.tenant_command_attempts as entry
  where entry.id = p_attempt_id;

  return result;
end;
$$;


CREATE OR REPLACE FUNCTION ops.tenant_command_attempts_json (p_command_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  select coalesce(
    jsonb_agg(ops.tenant_attempt_json(entry.id) order by entry.attempt_no),
    '[]'::jsonb
  )
  into result
  from ops.tenant_command_attempts as entry
  where entry.command_id = p_command_id;

  return result;
end;
$$;


-- ── 4. 建映射与改映射 ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_tenant_mapping (
  p_customer_id uuid,
  p_product_id uuid,
  p_udone_organization_id uuid DEFAULT NULL,
  p_external_ref text DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  existing_id uuid;
  new_id uuid;
  new_no text;
begin
  perform ops.require_permission('tenant.provision');

  if not exists (select 1 from ops.customers as entry where entry.id = p_customer_id) then
    return jsonb_build_object('status', 'customer_not_found');
  end if;

  if not exists (select 1 from ops.products as entry where entry.id = p_product_id) then
    return jsonb_build_object('status', 'product_not_found');
  end if;

  if p_udone_organization_id is not null then
    select entry.id into existing_id
    from ops.tenant_mappings as entry
    where entry.udone_organization_id = p_udone_organization_id;

    -- 契约 §3.6「冲突时拒绝，不得自动改绑」。改绑是一次显式操作
    -- （PATCH，且只在 pending 期间），不能悄悄发生在一个创建请求里。
    if existing_id is not null then
      return jsonb_build_object(
        'status', 'tenant_mapping_conflict',
        'existing_mapping_id', existing_id
      );
    end if;
  end if;

  insert into ops.tenant_mappings (
    customer_id, product_id, udone_organization_id, external_ref,
    mapping_status, created_by, updated_by
  )
  values (
    p_customer_id, p_product_id, p_udone_organization_id,
    nullif(btrim(coalesce(p_external_ref, '')), ''),
    'pending', actor_id, actor_id
  )
  returning id, mapping_no into new_id, new_no;

  perform ops.write_audit(
    'tenant_mapping.created',
    'tenant_mapping',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'mappingNo', new_no,
      'customerId', p_customer_id,
      'productId', p_product_id,
      'udoneOrganizationId', p_udone_organization_id,
      'mappingStatus', 'pending'
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'mapping', ops.tenant_mapping_json(new_id)
  );
end;
$$;


-- PATCH 的两个字段都可选，而 SQL 的「没传」与「传了 null」在函数签名里长得
-- 一模一样。用一对 set_* 布尔把这件事显式化——靠 `coalesce(p_x, old)` 猜，
-- 就永远没办法把 external_ref 主动清空。
CREATE OR REPLACE FUNCTION ops.update_tenant_mapping (
  p_mapping_id uuid,
  p_set_organization boolean DEFAULT FALSE,
  p_udone_organization_id uuid DEFAULT NULL,
  p_set_external_ref boolean DEFAULT FALSE,
  p_external_ref text DEFAULT NULL,
  p_version integer DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  entry record;
  existing_id uuid;
  next_org uuid;
  next_ref text;
  before_json jsonb;
begin
  perform ops.require_permission('tenant.provision');

  select * into entry
  from ops.tenant_mappings as target
  where target.id = p_mapping_id
  for update;

  if not found then
    return jsonb_build_object('status', 'mapping_not_found');
  end if;

  if p_version is not null and p_version <> entry.version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', entry.version
    );
  end if;

  -- 契约 §5.7：非 `pending` 禁止改外部 ID。绑定错了要改，只能先把映射退回
  -- pending——那是一步看得见的操作，而不是在 active 状态下悄悄换掉 org id，
  -- 让远端那台机器的授权指向另一个客户。
  if p_set_organization and entry.mapping_status <> 'pending' then
    return jsonb_build_object(
      'status', 'mapping_not_pending',
      'mapping_status', entry.mapping_status
    );
  end if;

  if p_set_organization and p_udone_organization_id is null then
    return jsonb_build_object('status', 'organization_required');
  end if;

  if p_set_organization then
    select target.id into existing_id
    from ops.tenant_mappings as target
    where target.udone_organization_id = p_udone_organization_id
      and target.id <> p_mapping_id;

    if existing_id is not null then
      return jsonb_build_object(
        'status', 'tenant_mapping_conflict',
        'existing_mapping_id', existing_id
      );
    end if;
  end if;

  next_org := case when p_set_organization then p_udone_organization_id else entry.udone_organization_id end;
  next_ref := case
    when p_set_external_ref then nullif(btrim(coalesce(p_external_ref, '')), '')
    else entry.external_ref
  end;

  -- 什么都没变就不动版本号。PATCH 传回同一组值是最常见的一次「保存」，
  -- 让它把 version +1 会让并发编辑的一方莫名收到 version_mismatch。
  if next_org is not distinct from entry.udone_organization_id
    and next_ref is not distinct from entry.external_ref then
    return jsonb_build_object(
      'status', 'ok',
      'mapping', ops.tenant_mapping_json(p_mapping_id)
    );
  end if;

  before_json := jsonb_build_object(
    'udoneOrganizationId', entry.udone_organization_id,
    'externalRef', entry.external_ref
  );

  update ops.tenant_mappings
  set
    udone_organization_id = next_org,
    external_ref = next_ref,
    updated_by = actor_id,
    updated_at = now(),
    version = version + 1
  where id = p_mapping_id;

  perform ops.write_audit(
    'tenant_mapping.updated',
    'tenant_mapping',
    p_mapping_id,
    p_reason,
    before_json,
    jsonb_build_object(
      'udoneOrganizationId', next_org,
      'externalRef', next_ref
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'mapping', ops.tenant_mapping_json(p_mapping_id)
  );
end;
$$;


-- ── 5. 建命令 ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_tenant_command (
  p_mapping_id uuid,
  p_command_type text,
  p_reason text,
  p_idempotency_key text,
  p_contract_id uuid DEFAULT NULL,
  p_change_request_id uuid DEFAULT NULL,
  p_expected_sync_version integer DEFAULT NULL,
  p_payload jsonb DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  permission_code text;
  entry record;
  existing record;
  change_status text;
  new_id uuid;
  new_no text;
begin
  permission_code := ops.command_required_permission(p_command_type);
  if permission_code is null then
    return jsonb_build_object('status', 'invalid_command_type');
  end if;

  -- 按命令类型判权限，不按端点判（设计要点 7）。
  perform ops.require_permission(permission_code);

  -- 幂等：同一把键重放同一件事 → 返回原命令；重放另一件事 → 冲突。
  -- 先查再插而不是靠 UNIQUE 兜底，因为「重放」必须是 202 + 原 id，
  -- 让客户端拿到和第一次一样的 commandNo 才能对上远端的操作记录。
  select * into existing
  from ops.tenant_commands as target
  where target.idempotency_key = p_idempotency_key;

  if found then
    if existing.mapping_id is distinct from p_mapping_id
      or existing.command_type <> p_command_type then
      return jsonb_build_object(
        'status', 'idempotency_conflict',
        'existing_command_id', existing.id,
        'existing_command_no', existing.command_no
      );
    end if;

    return jsonb_build_object(
      'status', 'ok',
      'command', ops.tenant_command_json(existing.id),
      'mapping', ops.tenant_mapping_json(existing.mapping_id),
      'replayed', true
    );
  end if;

  select * into entry
  from ops.tenant_mappings as target
  where target.id = p_mapping_id
  for update;

  if not found then
    return jsonb_build_object('status', 'mapping_not_found');
  end if;

  -- 入站形状先于状态判断：一条空 reason 的命令无论映射现在是什么状态都该被拒，
  -- 而「先报状态不匹配」会让人去查版本号，其实那一步根本还没走到。
  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if p_expected_sync_version is null then
    return jsonb_build_object('status', 'expected_sync_version_required');
  end if;

  if p_expected_sync_version <> entry.sync_version then
    return jsonb_build_object(
      'status', 'sync_version_mismatch',
      'current_sync_version', entry.sync_version
    );
  end if;

  if p_change_request_id is not null then
    select target.status into change_status
    from ops.entitlement_change_requests as target
    where target.id = p_change_request_id;

    if not found then
      return jsonb_build_object('status', 'change_request_not_found');
    end if;

    -- 契约 §3.6：关联变更申请必须已审批。未审批就下发等于把「批不批」这件事
    -- 交给远端——它会照做，而运营侧从此有一份没人批过的权益。
    if change_status <> 'approved' then
      return jsonb_build_object(
        'status', 'change_request_not_approved',
        'change_request_status', change_status
      );
    end if;
  end if;

  -- 命令与映射状态的匹配。这张表是「同一个 mapping 在不同阶段能收到什么命令」
  -- 的唯一一份定义，判断顺序与 §3.6 的开通路径一致：
  --   pending（无 org id）→ provision/bind → pending（有 org id）→ activate → active
  if p_command_type in ('provision', 'bind') then
    if entry.udone_organization_id is not null then
      return jsonb_build_object(
        'status', 'mapping_already_bound',
        'udone_organization_id', entry.udone_organization_id
      );
    end if;
  elsif p_command_type = 'activate' then
    if entry.udone_organization_id is null then
      return jsonb_build_object('status', 'mapping_not_bound');
    end if;
  elsif p_command_type = 'suspend' then
    if entry.mapping_status <> 'active' then
      return jsonb_build_object(
        'status', 'mapping_not_active',
        'mapping_status', entry.mapping_status
      );
    end if;
  elsif p_command_type = 'resume' then
    if entry.mapping_status <> 'suspended' then
      return jsonb_build_object(
        'status', 'mapping_not_suspended',
        'mapping_status', entry.mapping_status
      );
    end if;
  elsif p_command_type = 'revoke' then
    if entry.mapping_status not in ('active', 'suspended') then
      return jsonb_build_object(
        'status', 'mapping_not_active',
        'mapping_status', entry.mapping_status
      );
    end if;
  else
    -- sync_entitlement / extend：只有已经在跑的租户才谈得上同步权益。
    if entry.mapping_status <> 'active' then
      return jsonb_build_object(
        'status', 'mapping_not_active',
        'mapping_status', entry.mapping_status
      );
    end if;
  end if;

  insert into ops.tenant_commands (
    idempotency_key, mapping_id, command_type, customer_id, contract_id,
    change_request_id, expected_sync_version, reason, status,
    request_summary, created_by
  )
  values (
    btrim(p_idempotency_key), p_mapping_id, p_command_type, entry.customer_id,
    p_contract_id, p_change_request_id, p_expected_sync_version,
    btrim(p_reason), 'pending',
    coalesce(p_payload, '{}'::jsonb), actor_id
  )
  returning id, command_no into new_id, new_no;

  perform ops.write_audit(
    'tenant_command.created',
    'tenant_command',
    new_id,
    btrim(p_reason),
    null,
    jsonb_build_object(
      'commandNo', new_no,
      'mappingId', p_mapping_id,
      'commandType', p_command_type,
      'expectedSyncVersion', p_expected_sync_version,
      'changeRequestId', p_change_request_id,
      'status', 'pending'
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'command', ops.tenant_command_json(new_id),
    'mapping', ops.tenant_mapping_json(p_mapping_id),
    'replayed', false
  );
end;
$$;


-- ── 6. 命令的重试与取消 ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.transition_tenant_command (
  p_command_id uuid,
  p_action text,
  p_reason text,
  p_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  entry record;
  permission_code text;
  allowed_actions text[];
  before_json jsonb;
begin
  select * into entry
  from ops.tenant_commands as target
  where target.id = p_command_id
  for update;

  if not found then
    return jsonb_build_object('status', 'command_not_found');
  end if;

  permission_code := ops.command_required_permission(entry.command_type);
  perform ops.require_permission(permission_code);

  -- `retry` 除了原动作码还要 tenant.retry（契约 §5.7）。分开判而不是取并集：
  -- 给了一个动作码就重试，等于让 `tenant.suspend` 顺带获得无限重试权。
  if p_action = 'retry' then
    perform ops.require_permission('tenant.retry');
  end if;

  allowed_actions := ops.allowed_command_actions(entry.status);

  if not (p_action = any (allowed_actions)) then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', entry.status,
      'allowed_actions', to_jsonb(allowed_actions)
    );
  end if;

  if p_version is not null and p_version <> entry.version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', entry.version
    );
  end if;

  before_json := jsonb_build_object('status', entry.status, 'version', entry.version);

  if p_action = 'retry' then
    if entry.last_error_category = 'permanent' then
      return jsonb_build_object(
        'status', 'permanent_error',
        'last_error_code', entry.last_error_code
      );
    end if;

    update ops.tenant_commands
    set
      status = 'retrying',
      completed_at = null,
      next_retry_at = null,
      version = version + 1
    where id = p_command_id;
  else
    -- 契约 §3.6：`cancel` 仅限「未发生任何尝试」。
    if entry.attempt_count > 0 then
      return jsonb_build_object(
        'status', 'command_attempted',
        'attempt_count', entry.attempt_count
      );
    end if;

    update ops.tenant_commands
    set
      status = 'cancelled',
      completed_at = now(),
      next_retry_at = null,
      version = version + 1
    where id = p_command_id;
  end if;

  perform ops.write_audit(
    case when p_action = 'retry' then 'tenant_command.retried' else 'tenant_command.cancelled' end,
    'tenant_command',
    p_command_id,
    nullif(btrim(coalesce(p_reason, '')), ''),
    before_json,
    jsonb_build_object(
      'status', case when p_action = 'retry' then 'retrying' else 'cancelled' end
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'command', ops.tenant_command_json(p_command_id)
  );
end;
$$;


-- ── 7. 记录一次下发结果（系统侧，不授给 authenticated）────────────────────
-- 这是唯一能把命令推进终态的函数，也是「202 只表示已受理」这条承诺的落点：
-- 运营端没有 EXECUTE 权限，任何有 tenant.* 的账号都伪造不出一次「下发成功」。
CREATE OR REPLACE FUNCTION ops.record_tenant_command_attempt (
  p_command_id uuid,
  p_outcome text,
  p_http_status integer DEFAULT NULL,
  p_error_category text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_response_summary jsonb DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_request_summary jsonb DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  command_entry record;
  mapping_entry record;
  has_mapping boolean := false;
  attempt_no integer;
  attempt_id uuid;
  org_text text;
  new_org uuid;
  new_mapping_status text;
  new_state text;
  existing_id uuid;
  before_json jsonb;
begin
  if p_outcome not in ('succeeded', 'failed', 'timeout') then
    return jsonb_build_object('status', 'invalid_outcome');
  end if;

  select * into command_entry
  from ops.tenant_commands as target
  where target.id = p_command_id
  for update;

  if not found then
    return jsonb_build_object('status', 'command_not_found');
  end if;

  -- 终态不可再写。`cancelled` 也算：取消意味着「从来没发出去」，此时补一条
  -- attempt 会让「一次都没试过」这个前提当场失效，而取消已经据此成立过了。
  if command_entry.status in ('succeeded', 'cancelled') then
    return jsonb_build_object(
      'status', 'command_terminated',
      'current_status', command_entry.status
    );
  end if;

  if command_entry.mapping_id is not null then
    select * into mapping_entry
    from ops.tenant_mappings as target
    where target.id = command_entry.mapping_id
    for update;

    has_mapping := found;
  end if;

  -- 成功路径的落库前校验：org id 形状与改绑冲突都必须在写 attempt 之前判完，
  -- 否则会出现「attempt 记了成功、但映射没更新」的半截状态——而 attempt 不可删。
  if has_mapping then
    new_org := mapping_entry.udone_organization_id;
    new_mapping_status := mapping_entry.mapping_status;
  end if;
  new_state := nullif(btrim(coalesce(p_response_summary ->> 'state', '')), '');

  if p_outcome = 'succeeded'
    and has_mapping
    and command_entry.command_type in ('provision', 'bind') then
    org_text := nullif(btrim(coalesce(p_response_summary ->> 'udoneOrganizationId', '')), '');

    if org_text is not null then
      if org_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return jsonb_build_object('status', 'invalid_organization_id', 'value', org_text);
      end if;

      new_org := org_text::uuid;

      select target.id into existing_id
      from ops.tenant_mappings as target
      where target.udone_organization_id = new_org
        and target.id <> mapping_entry.id;

      if existing_id is not null then
        return jsonb_build_object(
          'status', 'tenant_mapping_conflict',
          'existing_mapping_id', existing_id
        );
      end if;
    end if;

    -- provision 成功了却拿不到 org id，就没有任何东西能证明「租户真的被建了」。
    -- 此时记一条 failed 比记一条 succeeded 更接近事实。
    if new_org is null then
      return jsonb_build_object('status', 'organization_missing_in_response');
    end if;
  end if;

  if p_outcome = 'succeeded' and has_mapping then
    new_mapping_status := case command_entry.command_type
      when 'activate' then 'active'
      when 'resume' then 'active'
      when 'suspend' then 'suspended'
      when 'revoke' then 'terminated'
      else mapping_entry.mapping_status
    end;
  end if;

  attempt_no := command_entry.attempt_count + 1;

  insert into ops.tenant_command_attempts (
    command_id, attempt_no, started_at, finished_at, outcome, http_status,
    error_category, request_id, response_summary, actor_id
  )
  values (
    p_command_id, attempt_no, now(), now(), p_outcome, p_http_status,
    p_error_category, p_request_id, p_response_summary, actor_id
  )
  returning id into attempt_id;

  if p_outcome = 'succeeded' then
    update ops.tenant_commands
    set
      status = 'succeeded',
      attempt_count = attempt_no,
      last_error_code = null,
      last_error_category = null,
      response_summary = p_response_summary,
      request_summary = coalesce(p_request_summary, request_summary),
      request_id = coalesce(p_request_id, request_id),
      next_retry_at = null,
      completed_at = now(),
      version = version + 1
    where id = p_command_id;

    if has_mapping then
      update ops.tenant_mappings
      set
        udone_organization_id = new_org,
        mapping_status = new_mapping_status,
        last_known_state = coalesce(new_state, new_mapping_status),
        last_synced_at = now(),
        -- 版本只在这里 +1（设计要点 3）。失败的尝试不动它。
        sync_version = sync_version + 1,
        updated_at = now(),
        version = version + 1
      where id = mapping_entry.id;
    end if;
  elsif p_outcome = 'failed' then
    update ops.tenant_commands
    set
      status = 'failed',
      attempt_count = attempt_no,
      last_error_code = p_error_code,
      last_error_category = coalesce(p_error_category, 'unknown'),
      response_summary = p_response_summary,
      request_summary = coalesce(p_request_summary, request_summary),
      request_id = coalesce(p_request_id, request_id),
      -- `permanent` 不给下一次时间：给了等于在界面上留一个「还能重试」的暗示。
      next_retry_at = case
        when coalesce(p_error_category, 'unknown') = 'permanent' then null
        else now() + ops.tenant_retry_backoff(attempt_no)
      end,
      completed_at = now(),
      version = version + 1
    where id = p_command_id;
  else
    -- 超时不结束命令（设计要点 5）。`retrying` 也退回 `pending`：
    -- 结果未知就是「还没办成」，而 `retrying` 表达的是「正在办」。
    update ops.tenant_commands
    set
      status = 'pending',
      attempt_count = attempt_no,
      response_summary = p_response_summary,
      request_summary = coalesce(p_request_summary, request_summary),
      request_id = coalesce(p_request_id, request_id),
      next_retry_at = now() + ops.tenant_retry_backoff(attempt_no),
      completed_at = null,
      version = version + 1
    where id = p_command_id;
  end if;

  before_json := jsonb_build_object(
    'status', command_entry.status,
    'attemptCount', command_entry.attempt_count
  );

  perform ops.write_audit(
    case p_outcome
      when 'succeeded' then 'tenant_command.succeeded'
      when 'failed' then 'tenant_command.failed'
      else 'tenant_command.timed_out'
    end,
    'tenant_command',
    p_command_id,
    null,
    before_json,
    jsonb_build_object(
      'outcome', p_outcome,
      'attemptNo', attempt_no,
      'httpStatus', p_http_status,
      'errorCategory', p_error_category,
      'errorCode', p_error_code
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'command', ops.tenant_command_json(p_command_id),
    'attempt', ops.tenant_attempt_json(attempt_id),
    'mapping', case
      when has_mapping then ops.tenant_mapping_json(mapping_entry.id)
      else null
    end
  );
end;
$$;


-- ── 8. 读：映射 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_tenant_mappings (
  p_customer_id uuid DEFAULT NULL,
  p_mapping_status text DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('tenant.read');

  with filtered as (
    select entry.*
    from ops.tenant_mappings as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (p_mapping_status is null or entry.mapping_status = p_mapping_status)
      and (p_product_id is null or entry.product_id = p_product_id)
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.created_at desc, filtered.mapping_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.tenant_mapping_json(page.id) order by
          filtered.created_at desc, filtered.mapping_no desc, filtered.id
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


CREATE OR REPLACE FUNCTION ops.get_tenant_mapping (p_mapping_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  mapping jsonb;
  commands jsonb;
begin
  perform ops.require_permission('tenant.read');

  mapping := ops.tenant_mapping_json(p_mapping_id);
  if mapping is null then
    return jsonb_build_object('status', 'mapping_not_found');
  end if;

  -- 契约 §5.7「`commands[]`（最近 20 条）」。上限写死在函数里而不是分页参数：
  -- 详情页要的是「最近发生了什么」，翻页去列表端点。
  select coalesce(
    jsonb_agg(ops.tenant_command_json(recent.id) order by recent.created_at desc, recent.id),
    '[]'::jsonb
  )
  into commands
  from (
    select entry.id, entry.created_at
    from ops.tenant_commands as entry
    where entry.mapping_id = p_mapping_id
    order by entry.created_at desc, entry.id
    limit 20
  ) as recent;

  return jsonb_build_object(
    'status', 'ok',
    'mapping', mapping,
    'commands', commands
  );
end;
$$;


-- ── 9. 读：命令 ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_tenant_commands (
  p_mapping_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_command_type text DEFAULT NULL,
  p_created_from timestamptz DEFAULT NULL,
  p_created_to timestamptz DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('tenant.read');

  with filtered as (
    select entry.*
    from ops.tenant_commands as entry
    where (p_mapping_id is null or entry.mapping_id = p_mapping_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
      and (p_command_type is null or entry.command_type = p_command_type)
      and (p_created_from is null or entry.created_at >= p_created_from)
      -- 右端用 `<`：`createdTo` 传的是日期时区切出来的时刻，闭区间会让
      -- 「2026-10-31 到 2026-10-31」在当天 23:59:59.999 之后漏掉一条。
      and (p_created_to is null or entry.created_at < p_created_to)
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.created_at desc, filtered.command_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.tenant_command_json(page.id) order by
          filtered.created_at desc, filtered.command_no desc, filtered.id
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


CREATE OR REPLACE FUNCTION ops.get_tenant_command (p_command_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  command_json jsonb;
  attempts jsonb;
  status text;
  error_category text;
begin
  perform ops.require_permission('tenant.read');

  command_json := ops.tenant_command_json(p_command_id);
  if command_json is null then
    return jsonb_build_object('status', 'command_not_found');
  end if;

  status := command_json ->> 'status';
  error_category := command_json ->> 'last_error_category';
  attempts := ops.tenant_command_attempts_json(p_command_id);

  return jsonb_build_object(
    'status', 'ok',
    'command', command_json,
    'attempts', attempts,
    -- 契约 §5.7 的 `retryable`：只问「现在还能不能重试」，不问「该不该」。
    -- 权限在端点层判（tenant.retry + 原动作码），这里只判状态与错误类别——
    -- 把权限也揉进来会让同一个字段在有权限的人眼里是 true、别人眼里是 false。
    'retryable', status = 'failed' and error_category is distinct from 'permanent'
  );
end;
$$;


CREATE OR REPLACE FUNCTION ops.list_tenant_command_attempts (p_command_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
  total integer;
begin
  perform ops.require_permission('tenant.read');

  -- 先判命令存在再返回空数组：不存在与「存在但一次都没试过」在界面上
  -- 是两个页面（404 vs 空状态），合成一个会让「命令丢了」看起来像「还没发」。
  if not exists (select 1 from ops.tenant_commands as entry where entry.id = p_command_id) then
    return jsonb_build_object('status', 'command_not_found');
  end if;

  select count(*) into total
  from ops.tenant_command_attempts as entry
  where entry.command_id = p_command_id;

  select coalesce(
    jsonb_agg(ops.tenant_attempt_json(entry.id) order by entry.attempt_no),
    '[]'::jsonb
  )
  into result
  from ops.tenant_command_attempts as entry
  where entry.command_id = p_command_id;

  return jsonb_build_object('status', 'ok', 'total', total, 'items', result);
end;
$$;


-- ── 10. 授权 ───────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE ops.tenant_mappings,
ops.tenant_commands,
ops.tenant_command_attempts
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.tenant_mappings ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.tenant_commands ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.tenant_command_attempts ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON SEQUENCE ops.tenant_mapping_no_seq,
ops.tenant_command_no_seq
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allowed_command_actions (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.command_required_permission (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.tenant_retry_backoff (integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.tenant_mapping_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.tenant_command_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.tenant_attempt_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.tenant_command_attempts_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.tenant_command_attempt_immutable ()
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_tenant_mapping (uuid, uuid, uuid, text, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.update_tenant_mapping (uuid, boolean, uuid, boolean, text, integer, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_tenant_command (
  uuid,
  text,
  text,
  text,
  uuid,
  uuid,
  integer,
  jsonb
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.transition_tenant_command (uuid, text, text, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_tenant_mappings (uuid, text, uuid, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_tenant_mapping (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_tenant_commands (
  uuid,
  TEXT[],
  text,
  timestamptz,
  timestamptz,
  integer,
  integer
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_tenant_command (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_tenant_command_attempts (uuid)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.create_tenant_mapping (uuid, uuid, uuid, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_tenant_mapping (uuid, boolean, uuid, boolean, text, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_tenant_command (
  uuid,
  text,
  text,
  text,
  uuid,
  uuid,
  integer,
  jsonb
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_tenant_command (uuid, text, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_tenant_mappings (uuid, text, uuid, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_tenant_mapping (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_tenant_commands (
  uuid,
  TEXT[],
  text,
  timestamptz,
  timestamptz,
  integer,
  integer
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_tenant_command (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_tenant_command_attempts (uuid) TO authenticated,
service_role;


-- record_tenant_command_attempt 刻意**不**授给 authenticated（设计要点 4）。
-- 它只有 service_role 与超级用户能调——这是「202 只表示已受理」唯一的技术保证。
--
-- 这条 REVOKE 不能省：新建函数默认对 PUBLIC 有 EXECUTE，只写 GRANT 等于没拦。
-- A1 就是拿这件事当断言的——去掉这一行，它会从「42501」变成「没有异常」。
REVOKE ALL ON function ops.record_tenant_command_attempt (
  uuid,
  text,
  integer,
  text,
  text,
  jsonb,
  text,
  jsonb
)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.record_tenant_command_attempt (
  uuid,
  text,
  integer,
  text,
  text,
  jsonb,
  text,
  jsonb
) TO service_role;


COMMENT ON TABLE ops.tenant_mappings IS '租户映射。一个 udone 组织只能指向一个商业客户；sync_version 是乐观锁，只在远端确认后 +1。';


COMMENT ON TABLE ops.tenant_commands IS '租户命令台账。status=pending 只表示已受理，远端确认才 succeeded；只有 service_role 能推进终态。';


COMMENT ON TABLE ops.tenant_command_attempts IS '每次下发的尝试记录，只 INSERT。超时的尝试不结束命令。';