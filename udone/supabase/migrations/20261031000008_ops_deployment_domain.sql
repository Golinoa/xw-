-- 运营 deployment 域：两张表 + 十二个函数（契约 §3.7、§5.8 七个端点）。
--
-- 本域要回答的问题是「这台机器现在跑的是哪个版本，凭什么算数？」。答案分两层：
-- 当前版本是**一条可以被覆盖的结论**，历史是**一串不能被改写的记录**。两张表
-- 正好对应这两层：
--
--   deployment_instances        当前状态（current_version 是一列，会变）
--   deployment_version_records  每次升级的登记（只 INSERT，永远不变）
--
-- 1. **只有 `succeeded` 推进 `current_version`**（契约 D-07）。`failed` 与
--    `rolled_back` 都保持原值：失败回写会让「这台机器跑的是 1.5.0」变成一句
--    没有依据的话，而下游（维护到期、授权关联、工单引用）全都读这一列。
--    `rolled_back` 尤其不能回写——回滚成功的定义就是「还停在 from_version」。
--
-- 2. **`current_version` 不能通过 PATCH 改。** 契约 §5.8 的 PATCH 只说「可编辑
--    字段」，没列清单。若它可改，`from_version` 与当前版本的比对（T-11 唯一一条
--    拒绝断言）就永远能绕过：先 PATCH 到目标版本、再登记一条 1.5.0 → 1.5.0 的
--    记录，历史变成装饰。版本只能由「登记 + 成功结果」推进，这是历史可信的
--    前提。登记时的初始 `currentVersion` 仍可在 POST 里给（那是baseline）。
--
-- 3. **`from_version` 不符回 `version_mismatch`，但当前版本为 NULL 时例外。**
--    POST 允许不带 `currentVersion` 建实例（契约 §5.8 把它标成可选）。此时没有
--    任何基线可比——第一条成功的记录就是基线。若按「NULL 匹配不上任何值」硬判，
--    这条实例永远登不上第一条升级记录，而契约并没有留别的路。
--
-- 4. **「最后上报时间」是派生值，不落列**（D-04）。取最近一条版本记录的
--    `created_at`，列头注明口径。加一列 `last_reported_at` 需要一条上报链路
--    （实例自己定期打点），当前没有——那种列只会一直是 NULL，比没有更糟。
--
-- 5. **状态迁移的合法性由 `allowed_deployment_actions` 单点决定**（契约 §3.7）。
--    详情里的 `allowedActions`、非法迁移回包里的 `allowedActions`、前端按钮三处
--    读同一份。三份副本里漏一条边，症状是「按钮点得动但一直 409」。
--
-- 6. **`active`/`maintenance` 必须有 `go_live_on`（表级 CHECK）。** 契约把
--    「`go_live` 需 `go_live_on`」写成动作级校验（400）。动作级能挡住正常路径，
--    挡不住「先建一条 active 再补日期」这种绕过；而「已上线但没有上线日期」的
--    实例会让「上线时长」这类统计直接算不出来。
--
-- 7. **禁止列清单不靠自觉**（PRD §6.8 / §10.2）：本域的表里不得出现
--    `ssh_private_key` / `ssh_password` / `db_password` / `root_password` /
--    `admin_token` / `connection_string` / `install_package_url`。pgTAP 用
--    `information_schema.columns` 做白名单断言（D2），不是代码评审看一眼。
--
-- 8. **`license_id` 与 `private_licenses.deployment_instance_id` 是两个方向。**
--    前者是「开通时指定的主授权」，后者是「这份授权绑在哪台机器上」，由 o-t09
--    的部分唯一索引（一台机器同时只能有一份有效授权）约束。详情里的
--    `licenses[]` 走后者（权威方向），`license_id` 只做摘要展示。两者可能不一致
--    （先建实例、后建授权），刻意不互相回写——回写会在两个地方各留一次真相。
-- ── 1. 序列与表 ────────────────────────────────────────────────────────────
CREATE SEQUENCE ops.deployment_instance_no_seq AS bigint START
WITH
  1;


CREATE TABLE ops.deployment_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_no text NOT NULL DEFAULT (
    'DEP-' || lpad(
      nextval('ops.deployment_instance_no_seq')::text,
      6,
      '0'
    )
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  deployment_type text NOT NULL CHECK (deployment_type IN ('private', 'dedicated')),
  -- 客户环境标识（对方内部的命名，例如「bj-prod-01」），不是连接串。
  environment_ref text,
  current_version text,
  status text NOT NULL DEFAULT 'planned' CHECK (
    status IN ('planned', 'active', 'maintenance', 'retired')
  ),
  go_live_on date,
  maintenance_until date,
  owner_operator_id uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  contract_id uuid REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  license_id uuid REFERENCES ops.private_licenses (id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deployment_instances_instance_no_key UNIQUE (instance_no),
  -- 契约 §3.7 的 `UNIQUE(customer_id, name)`：同一客户下重名实例会让工单里的
  -- 「部署实例」下拉出现两个一摸一样的选项，选错之后所有后续记录都挂错机器。
  CONSTRAINT deployment_instances_customer_name_key UNIQUE (customer_id, name),
  CONSTRAINT deployment_instances_live_check CHECK (
    status NOT IN ('active', 'maintenance')
    OR go_live_on IS NOT NULL
  ),
  CONSTRAINT deployment_instances_environment_ref_check CHECK (
    environment_ref IS NULL
    OR length(btrim(environment_ref)) > 0
  ),
  CONSTRAINT deployment_instances_version_text_check CHECK (
    current_version IS NULL
    OR length(btrim(current_version)) > 0
  )
);


CREATE INDEX deployment_instances_status_idx ON ops.deployment_instances (status, maintenance_until);


CREATE INDEX deployment_instances_version_idx ON ops.deployment_instances (current_version);


CREATE INDEX deployment_instances_customer_idx ON ops.deployment_instances (customer_id);


CREATE TABLE ops.deployment_version_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES ops.deployment_instances (id) ON DELETE RESTRICT,
  from_version text NOT NULL CHECK (length(btrim(from_version)) > 0),
  to_version text NOT NULL CHECK (length(btrim(to_version)) > 0),
  executed_on date NOT NULL,
  -- 契约为 `executed_by uuid NOT NULL`：升级记录必须能追到人。取会话里的操作员，
  -- 所以这个 RPC 不能由 service_role 代跑（那会让 executed_by 变成 NULL 而报错，
  -- 而不是悄悄记一条「谁都不是」的记录）。
  executed_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  result text NOT NULL CHECK (result IN ('succeeded', 'failed', 'rolled_back')),
  impact_note text,
  rollback_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX deployment_version_records_instance_idx ON ops.deployment_version_records (instance_id, executed_on DESC);


-- 升级记录只 INSERT（契约 §3.7）。和授权快照、租户尝试一样，只靠 REVOKE 挡不住
-- 表属主——而「这次升级其实失败了」被改成成功，等于把 `current_version` 的依据
-- 抹掉。所以补一层触发器，让属主也改不了。
CREATE OR REPLACE FUNCTION ops.deployment_version_record_immutable () returns trigger language plpgsql
SET
  search_path = '' AS $$
begin
  raise exception 'ops deployment version records are append-only' using errcode = 'restrict_violation';
end;
$$;


CREATE TRIGGER deployment_version_records_immutable
BEFORE UPDATE OR DELETE ON ops.deployment_version_records FOR EACH ROW
EXECUTE FUNCTION ops.deployment_version_record_immutable ();


-- ── 2. 状态机与出站形状 ───────────────────────────────────────────────────
-- 契约 §3.7 的五条边。`retired` 是终态：设备下线之后重新上线是**另一台实例**
-- （换机器、换授权），把同一行改回 active 会让两段互不相关的历史接在一起。
CREATE OR REPLACE FUNCTION ops.allowed_deployment_actions (p_status text) returns TEXT[] language sql immutable
SET
  search_path = '' AS $$
  select case p_status
    when 'planned' then array['go_live', 'retire']
    when 'active' then array['start_maintenance', 'retire']
    when 'maintenance' then array['end_maintenance', 'retire']
    else array[]::text[]
  end;
$$;


-- 单条实例的出站形状（snake_case，出站由 protocol.ts 转 camelCase）。
--
-- `last_reported_at` 是派生值（设计要点 4），走 `deployment_version_records`
-- 的最近一条 `created_at`。没有 `last_reported_at` 列。
CREATE OR REPLACE FUNCTION ops.deployment_instance_json (p_instance_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', entry.id,
    'instance_no', entry.instance_no,
    'customer', jsonb_build_object(
      'id', customer.id,
      'customer_no', customer.customer_no,
      'name', customer.name
    ),
    'name', entry.name,
    'deployment_type', entry.deployment_type,
    'environment_ref', entry.environment_ref,
    'current_version', entry.current_version,
    'status', entry.status,
    'go_live_on', entry.go_live_on,
    'maintenance_until', entry.maintenance_until,
    'owner', (
      select jsonb_build_object(
        'id', owner.id,
        'display_name', owner.display_name,
        'status', owner.status
      )
      from ops.operators as owner
      where owner.id = entry.owner_operator_id
    ),
    'contract_id', entry.contract_id,
    'license_id', entry.license_id,
    'last_reported_at', (
      select max(record.created_at)
      from ops.deployment_version_records as record
      where record.instance_id = entry.id
    ),
    'version', entry.version,
    'created_at', entry.created_at,
    'updated_at', entry.updated_at
  )
  into result
  from ops.deployment_instances as entry
  join ops.customers as customer on customer.id = entry.customer_id
  where entry.id = p_instance_id;

  return result;
end;
$$;


CREATE OR REPLACE FUNCTION ops.deployment_version_record_json (p_record_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'id', entry.id,
    'instance_id', entry.instance_id,
    'from_version', entry.from_version,
    'to_version', entry.to_version,
    'executed_on', entry.executed_on,
    'executed_by', jsonb_build_object(
      'id', operator.id,
      'display_name', operator.display_name
    ),
    'result', entry.result,
    'impact_note', entry.impact_note,
    'rollback_note', entry.rollback_note,
    'created_at', entry.created_at
  )
  into result
  from ops.deployment_version_records as entry
  join ops.operators as operator on operator.id = entry.executed_by
  where entry.id = p_record_id;

  return result;
end;
$$;


-- ── 3. 写：建实例 ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_deployment_instance (
  p_customer_id uuid,
  p_name text,
  p_deployment_type text,
  p_environment_ref text DEFAULT NULL,
  p_current_version text DEFAULT NULL,
  p_go_live_on date DEFAULT NULL,
  p_maintenance_until date DEFAULT NULL,
  p_owner_operator_id uuid DEFAULT NULL,
  p_license_id uuid DEFAULT NULL,
  p_contract_id uuid DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  operator_id uuid := ops.current_operator_id();
  new_id uuid;
  license_customer uuid;
  contract_customer uuid;
begin
  perform ops.require_permission('deployment.write');

  if p_deployment_type not in ('private', 'dedicated') then
    return jsonb_build_object('status', 'invalid_deployment_type', 'value', p_deployment_type);
  end if;

  if p_name is null or length(btrim(p_name)) = 0 then
    return jsonb_build_object('status', 'name_required');
  end if;

  if not exists (select 1 from ops.customers as target where target.id = p_customer_id) then
    return jsonb_build_object('status', 'customer_not_found');
  end if;

  if p_owner_operator_id is not null
    and not exists (
      select 1 from ops.operators as target where target.id = p_owner_operator_id
    ) then
    return jsonb_build_object('status', 'owner_not_found');
  end if;

  -- 授权与合同都必须属于同一个客户：拿 A 客户的授权给 B 客户的机器上线，
  -- 之后按客户算「已授权未部署」与「已部署未授权」两张表都会算错。
  if p_license_id is not null then
    select entry.customer_id into license_customer
    from ops.private_licenses as entry
    where entry.id = p_license_id;

    if license_customer is null then
      return jsonb_build_object('status', 'license_not_found');
    end if;

    if license_customer <> p_customer_id then
      return jsonb_build_object('status', 'license_customer_mismatch');
    end if;
  end if;

  if p_contract_id is not null then
    select entry.customer_id into contract_customer
    from ops.contracts as entry
    where entry.id = p_contract_id;

    if contract_customer is null then
      return jsonb_build_object('status', 'contract_not_found');
    end if;

    if contract_customer <> p_customer_id then
      return jsonb_build_object('status', 'contract_customer_mismatch');
    end if;
  end if;

  begin
    insert into ops.deployment_instances (
      customer_id, name, deployment_type, environment_ref, current_version,
      go_live_on, maintenance_until, owner_operator_id, license_id, contract_id,
      created_by, updated_by
    )
    values (
      p_customer_id, btrim(p_name), p_deployment_type,
      nullif(btrim(coalesce(p_environment_ref, '')), ''),
      nullif(btrim(coalesce(p_current_version, '')), ''),
      p_go_live_on, p_maintenance_until, p_owner_operator_id, p_license_id, p_contract_id,
      operator_id, operator_id
    )
    returning id into new_id;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'name_taken', 'name', btrim(p_name));
  end;

  perform ops.write_audit(
    'deployment.created',
    'deployment_instance',
    new_id,
    null,
    null,
    jsonb_build_object(
      'instanceNo', (select entry.instance_no from ops.deployment_instances as entry where entry.id = new_id),
      'customerId', p_customer_id,
      'name', btrim(p_name),
      'deploymentType', p_deployment_type,
      'currentVersion', nullif(btrim(coalesce(p_current_version, '')), ''),
      'licenseId', p_license_id
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'deployment', ops.deployment_instance_json(new_id));
end;
$$;


-- ── 4. 写：改实例 ─────────────────────────────────────────────────────────
-- `p_patch` 是 jsonb 而不是十四个 `p_set_* + 值` 参数：键存在与否用 `?` 判，
-- 「没传」与「传 null」天然分得开，而参数表不会随可编辑字段增长而膨胀。
--
-- `currentVersion` 不在可编辑集合里（设计要点 2）：它只能由「登记 + succeeded」
-- 推进。传进来会被当成未知键忽略——不是静默丢弃，字典里根本没有它。
CREATE OR REPLACE FUNCTION ops.update_deployment_instance (
  p_instance_id uuid,
  p_patch jsonb,
  p_expected_version integer DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  operator_id uuid := ops.current_operator_id();
  target ops.deployment_instances;
  next_name text;
  next_type text;
  next_environment text;
  next_maintenance date;
  next_go_live date;
  next_owner uuid;
  next_license uuid;
  next_contract uuid;
  license_customer uuid;
  contract_customer uuid;
  changed jsonb := '{}'::jsonb;
  before_json jsonb := '{}'::jsonb;
begin
  perform ops.require_permission('deployment.write');

  select * into target
  from ops.deployment_instances as entry
  where entry.id = p_instance_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  -- 已退役的实例不再接受编辑：退役意味着这台机器不再属于在管资产，还能改
  -- 负责人与维护到期日，会让「退役」看起来像一次暂停。
  if target.status = 'retired' then
    return jsonb_build_object('status', 'instance_retired');
  end if;

  next_name := target.name;
  next_type := target.deployment_type;
  next_environment := target.environment_ref;
  next_maintenance := target.maintenance_until;
  next_go_live := target.go_live_on;
  next_owner := target.owner_operator_id;
  next_license := target.license_id;
  next_contract := target.contract_id;

  if p_patch ? 'name' then
    next_name := nullif(btrim(coalesce(p_patch ->> 'name', '')), '');
    if next_name is null then
      return jsonb_build_object('status', 'name_required');
    end if;
  end if;

  if p_patch ? 'deploymentType' then
    next_type := p_patch ->> 'deploymentType';
    if next_type not in ('private', 'dedicated') then
      return jsonb_build_object('status', 'invalid_deployment_type', 'value', next_type);
    end if;
  end if;

  if p_patch ? 'environmentRef' then
    next_environment := nullif(btrim(coalesce(p_patch ->> 'environmentRef', '')), '');
  end if;

  if p_patch ? 'maintenanceUntil' then
    next_maintenance := (p_patch ->> 'maintenanceUntil')::date;
  end if;

  if p_patch ? 'goLiveOn' then
    next_go_live := (p_patch ->> 'goLiveOn')::date;
  end if;

  if p_patch ? 'ownerOperatorId' then
    next_owner := (p_patch ->> 'ownerOperatorId')::uuid;
    if next_owner is not null
      and not exists (select 1 from ops.operators as entry where entry.id = next_owner) then
      return jsonb_build_object('status', 'owner_not_found');
    end if;
  end if;

  if p_patch ? 'licenseId' then
    next_license := (p_patch ->> 'licenseId')::uuid;
    if next_license is not null then
      select entry.customer_id into license_customer
      from ops.private_licenses as entry
      where entry.id = next_license;

      if license_customer is null then
        return jsonb_build_object('status', 'license_not_found');
      end if;

      if license_customer <> target.customer_id then
        return jsonb_build_object('status', 'license_customer_mismatch');
      end if;
    end if;
  end if;

  if p_patch ? 'contractId' then
    next_contract := (p_patch ->> 'contractId')::uuid;
    if next_contract is not null then
      select entry.customer_id into contract_customer
      from ops.contracts as entry
      where entry.id = next_contract;

      if contract_customer is null then
        return jsonb_build_object('status', 'contract_not_found');
      end if;

      if contract_customer <> target.customer_id then
        return jsonb_build_object('status', 'contract_customer_mismatch');
      end if;
    end if;
  end if;

  -- 表级 CHECK 会在 update 时抛异常，先判一次给出可读的 reason：
  -- 「已上线却没有上线日期」是业务错误，不是数据库错误。
  if target.status in ('active', 'maintenance') and next_go_live is null then
    return jsonb_build_object('status', 'go_live_on_required');
  end if;

  if target.name is distinct from next_name then
    changed := changed || jsonb_build_object('name', next_name);
    before_json := before_json || jsonb_build_object('name', target.name);
  end if;
  if target.deployment_type is distinct from next_type then
    changed := changed || jsonb_build_object('deploymentType', next_type);
    before_json := before_json || jsonb_build_object('deploymentType', target.deployment_type);
  end if;
  if target.environment_ref is distinct from next_environment then
    changed := changed || jsonb_build_object('environmentRef', next_environment);
    before_json := before_json || jsonb_build_object('environmentRef', target.environment_ref);
  end if;
  if target.maintenance_until is distinct from next_maintenance then
    changed := changed || jsonb_build_object('maintenanceUntil', next_maintenance);
    before_json := before_json || jsonb_build_object('maintenanceUntil', target.maintenance_until);
  end if;
  if target.go_live_on is distinct from next_go_live then
    changed := changed || jsonb_build_object('goLiveOn', next_go_live);
    before_json := before_json || jsonb_build_object('goLiveOn', target.go_live_on);
  end if;
  if target.owner_operator_id is distinct from next_owner then
    changed := changed || jsonb_build_object('ownerOperatorId', next_owner);
    before_json := before_json || jsonb_build_object('ownerOperatorId', target.owner_operator_id);
  end if;
  if target.license_id is distinct from next_license then
    changed := changed || jsonb_build_object('licenseId', next_license);
    before_json := before_json || jsonb_build_object('licenseId', target.license_id);
  end if;
  if target.contract_id is distinct from next_contract then
    changed := changed || jsonb_build_object('contractId', next_contract);
    before_json := before_json || jsonb_build_object('contractId', target.contract_id);
  end if;

  -- 什么都没变就不写：一次「保存」没改任何字段也落一条审计、把 version 推一格，
  -- 会让乐观锁在两端之间无故失配。
  if changed = '{}'::jsonb then
    return jsonb_build_object('status', 'ok', 'deployment', ops.deployment_instance_json(target.id));
  end if;

  begin
    update ops.deployment_instances
    set
      name = next_name,
      deployment_type = next_type,
      environment_ref = next_environment,
      maintenance_until = next_maintenance,
      go_live_on = next_go_live,
      owner_operator_id = next_owner,
      license_id = next_license,
      contract_id = next_contract,
      updated_by = operator_id,
      updated_at = now(),
      version = version + 1
    where id = p_instance_id;
  exception
    when unique_violation then
      return jsonb_build_object('status', 'name_taken', 'name', next_name);
  end;

  perform ops.write_audit(
    'deployment.updated',
    'deployment_instance',
    p_instance_id,
    null,
    before_json,
    changed,
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'deployment', ops.deployment_instance_json(p_instance_id));
end;
$$;


-- ── 5. 写：状态迁移 ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.transition_deployment_instance (
  p_instance_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_go_live_on date DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  operator_id uuid := ops.current_operator_id();
  target ops.deployment_instances;
  allowed TEXT[];
  to_status text;
  next_go_live date;
  before_json jsonb;
begin
  perform ops.require_permission('deployment.write');

  select * into target
  from ops.deployment_instances as entry
  where entry.id = p_instance_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  allowed := ops.allowed_deployment_actions(target.status);

  if not (p_action = any (allowed)) then
    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', target.status,
      'allowed_actions', to_jsonb(allowed)
    );
  end if;

  to_status := case p_action
    when 'go_live' then 'active'
    when 'start_maintenance' then 'maintenance'
    when 'end_maintenance' then 'active'
    when 'retire' then 'retired'
  end;

  next_go_live := target.go_live_on;

  if p_action = 'go_live' then
    -- 契约 §5.8：`go_live` 缺 `goLiveOn` 回 400。实例上已经有值也算「不缺」——
    -- PATCH 允许在 planned 期间先填上线日期，那是同一个事实的另一种录入顺序。
    next_go_live := coalesce(p_go_live_on, target.go_live_on);

    if next_go_live is null then
      return jsonb_build_object('status', 'go_live_on_required');
    end if;
  end if;

  if p_action = 'retire' and (p_reason is null or length(btrim(p_reason)) = 0) then
    return jsonb_build_object('status', 'reason_required');
  end if;

  before_json := jsonb_build_object(
    'status', target.status,
    'goLiveOn', target.go_live_on,
    'action', p_action
  );

  update ops.deployment_instances
  set
    status = to_status,
    go_live_on = next_go_live,
    updated_by = operator_id,
    updated_at = now(),
    version = version + 1
  where id = p_instance_id;

  perform ops.write_audit(
    'deployment.transitioned',
    'deployment_instance',
    p_instance_id,
    nullif(btrim(coalesce(p_reason, '')), ''),
    before_json,
    jsonb_build_object('status', to_status, 'action', p_action, 'goLiveOn', next_go_live),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'deployment', ops.deployment_instance_json(p_instance_id),
    'allowed_actions', to_jsonb(ops.allowed_deployment_actions(to_status))
  );
end;
$$;


-- ── 6. 写：登记升级结果 ───────────────────────────────────────────────────
-- 这张表只增不改，所以「同一件事重放一次」不能靠幂等键在本函数里判——键在 HTTP
-- 层的中间件上。若中间件的缓存过期而请求被重发，第二次会撞上 `version_mismatch`
-- （当前版本已经被第一次推进了），这比静默落两条一模一样的升级记录好。
CREATE OR REPLACE FUNCTION ops.create_deployment_version_record (
  p_instance_id uuid,
  p_from_version text,
  p_to_version text,
  p_executed_on date,
  p_result text,
  p_impact_note text DEFAULT NULL,
  p_rollback_note text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  operator_id uuid := ops.current_operator_id();
  target ops.deployment_instances;
  from_version text := nullif(btrim(coalesce(p_from_version, '')), '');
  to_version text := nullif(btrim(coalesce(p_to_version, '')), '');
  new_id uuid;
  next_version text;
begin
  perform ops.require_permission('deployment.write');

  if p_result not in ('succeeded', 'failed', 'rolled_back') then
    return jsonb_build_object('status', 'invalid_result', 'value', p_result);
  end if;

  if from_version is null then
    return jsonb_build_object('status', 'from_version_required');
  end if;

  if to_version is null then
    return jsonb_build_object('status', 'to_version_required');
  end if;

  if p_executed_on is null then
    return jsonb_build_object('status', 'executed_on_required');
  end if;

  select * into target
  from ops.deployment_instances as entry
  where entry.id = p_instance_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 当前版本为 NULL 时不比对（设计要点 3）：没有基线可对，第一条记录就是基线。
  if target.current_version is not null and target.current_version <> from_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.current_version,
      'from_version', from_version
    );
  end if;

  insert into ops.deployment_version_records (
    instance_id, from_version, to_version, executed_on, executed_by, result,
    impact_note, rollback_note
  )
  values (
    p_instance_id, from_version, to_version, p_executed_on, operator_id, p_result,
    nullif(btrim(coalesce(p_impact_note, '')), ''),
    nullif(btrim(coalesce(p_rollback_note, '')), '')
  )
  returning id into new_id;

  -- 只有 succeeded 推进（设计要点 1）。failed / rolled_back 都不动。
  next_version := target.current_version;

  if p_result = 'succeeded' then
    next_version := to_version;

    update ops.deployment_instances
    set
      current_version = next_version,
      updated_by = operator_id,
      updated_at = now(),
      version = version + 1
    where id = p_instance_id;
  end if;

  perform ops.write_audit(
    'deployment_version.recorded',
    'deployment_version_record',
    new_id,
    null,
    jsonb_build_object('currentVersion', target.current_version),
    jsonb_build_object(
      'instanceId', p_instance_id,
      'fromVersion', from_version,
      'toVersion', to_version,
      'result', p_result,
      'currentVersion', next_version
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'version_record', ops.deployment_version_record_json(new_id),
    'deployment', ops.deployment_instance_json(p_instance_id)
  );
end;
$$;


-- ── 7. 读：实例列表 ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_deployment_instances (
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_deployment_type text DEFAULT NULL,
  p_current_version text DEFAULT NULL,
  p_maintenance_until_before date DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('deployment.read');

  with filtered as (
    select entry.*
    from ops.deployment_instances as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
      and (p_deployment_type is null or entry.deployment_type = p_deployment_type)
      and (p_current_version is null or entry.current_version = p_current_version)
      -- 「维护到期日早于某天」是运营端最常用的一问：到期前 30 天要提前续。
      -- 没有维护到期日的实例不进结果集——它没有「快到期」这件事。
      and (
        p_maintenance_until_before is null
        or (
          entry.maintenance_until is not null
          and entry.maintenance_until <= p_maintenance_until_before
        )
      )
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.created_at desc, filtered.instance_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.deployment_instance_json(page.id) order by
          filtered.created_at desc, filtered.instance_no desc, filtered.id
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


-- ── 8. 读：实例详情 ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.get_deployment_instance (p_instance_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  instance jsonb;
  records jsonb;
  licenses jsonb;
  tickets jsonb;
begin
  perform ops.require_permission('deployment.read');

  instance := ops.deployment_instance_json(p_instance_id);

  if instance is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 契约 §5.8：「`versionRecords[]`、`licenses[]`、`tickets[]`」。两个关联数组都
  -- 只回摘要而不是完整对象：详情页要的是「这台机器挂着什么」，点进去各有端点。
  select coalesce(
    jsonb_agg(
      ops.deployment_version_record_json(record.id)
      order by record.executed_on desc, record.created_at desc, record.id
    ),
    '[]'::jsonb
  )
  into records
  from ops.deployment_version_records as record
  where record.instance_id = p_instance_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', license.id,
        'license_no', license.license_no,
        'license_mode', license.license_mode,
        'status', license.status,
        'valid_from', license.valid_from,
        'valid_to', license.valid_to,
        'maintenance_until', license.maintenance_until
      )
      order by license.valid_from desc, license.id
    ),
    '[]'::jsonb
  )
  into licenses
  from ops.private_licenses as license
  where license.deployment_instance_id = p_instance_id;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', ticket.id,
        'ticket_no', ticket.ticket_no,
        'subject', ticket.subject,
        'priority', ticket.priority,
        'status', ticket.status
      )
      order by ticket.created_at desc, ticket.id
    ),
    '[]'::jsonb
  )
  into tickets
  from ops.tickets as ticket
  where ticket.deployment_instance_id = p_instance_id;

  return jsonb_build_object(
    'status', 'ok',
    'deployment', instance,
    'allowed_actions', to_jsonb(
      ops.allowed_deployment_actions((instance ->> 'status'))
    ),
    'versionRecords', records,
    'licenses', licenses,
    'tickets', tickets
  );
end;
$$;


-- ── 9. 读：升级记录列表 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_deployment_version_records (
  p_instance_id uuid,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
  total integer;
begin
  perform ops.require_permission('deployment.read');

  -- 实例不在就 404，而不是回一个空列表：空列表让「这机器没有升级记录」与
  -- 「这机器根本不存在」长得一样，前者是正常状态、后者是 id 传错了。
  if not exists (
    select 1 from ops.deployment_instances as entry where entry.id = p_instance_id
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select count(*) into total
  from ops.deployment_version_records as entry
  where entry.instance_id = p_instance_id;

  select coalesce(
    jsonb_agg(ops.deployment_version_record_json(page.id) order by
      entry.executed_on desc, entry.created_at desc, entry.id
    ),
    '[]'::jsonb
  )
  into result
  from (
    select record.id, record.executed_on, record.created_at
    from ops.deployment_version_records as record
    where record.instance_id = p_instance_id
    order by record.executed_on desc, record.created_at desc, record.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  ) as page
  join ops.deployment_version_records as entry on entry.id = page.id;

  return jsonb_build_object('status', 'ok', 'total', total, 'items', result);
end;
$$;


-- ── 10. 授权 ───────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE ops.deployment_instances,
ops.deployment_version_records
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.deployment_instances ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.deployment_version_records ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON SEQUENCE ops.deployment_instance_no_seq
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allowed_deployment_actions (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.deployment_instance_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.deployment_version_record_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.deployment_version_record_immutable ()
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_deployment_instance (
  uuid,
  text,
  text,
  text,
  text,
  date,
  date,
  uuid,
  uuid,
  uuid,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_deployment_instance (uuid, jsonb, integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.transition_deployment_instance (uuid, text, text, date, integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_deployment_version_record (uuid, text, text, date, text, text, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_deployment_instances (uuid, TEXT[], text, text, date, integer, integer)
FROM
  public,
  anon;


REVOKE ALL ON function ops.get_deployment_instance (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_deployment_version_records (uuid, integer, integer)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.create_deployment_instance (
  uuid,
  text,
  text,
  text,
  text,
  date,
  date,
  uuid,
  uuid,
  uuid,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_deployment_instance (uuid, jsonb, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_deployment_instance (uuid, text, text, date, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_deployment_version_record (uuid, text, text, date, text, text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_deployment_instances (uuid, TEXT[], text, text, date, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_deployment_instance (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_deployment_version_records (uuid, integer, integer) TO authenticated,
service_role;


COMMENT ON TABLE ops.deployment_instances IS '私有化部署实例。current_version 只能由 succeeded 的升级记录推进，PATCH 不可改。';