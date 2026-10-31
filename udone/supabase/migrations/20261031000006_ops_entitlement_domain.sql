-- 运营 entitlement 域：五张表 + 二十六个函数（契约 §3.5、§5.6 十五条）。
--
-- 本域的核心不是状态机，是**快照**。订阅和授权的「权益」不是一个可变字段，
-- 而是一串只增不改的快照；「当前权益」永远指向其中一张。所以这里的设计顺序
-- 是先有快照、再有主体：
--
-- 1. **快照只 INSERT，且由触发器兜底。** 契约 §5.6 写「快照是授权的证据链，
--    一旦写出即不可变」，T-09 的验收断言又要求 `UPDATE ops.entitlement_snapshots`
--    由 `authenticated` 执行报权限错误。REVOKE + RLS 挡住业务身份，触发器
--    挡住「绕过授权模型的写入」——两条都要：只有 REVOKE 时，任何以表属主身份
--    跑的运维脚本都能改掉一张已发出的权益凭证，而那种改动不会留下任何痕迹。
--
-- 2. **`content_hash` 是「同一份权益只发一次」的判据，不是校验和。**
--    契约 §3.5 用 `UNIQUE(source_type, source_id, content_hash)` 防重复发放。
--    所以 `create_snapshot` 先算哈希、命中就返回既有的那张，而不是报错——
--    重复提交同一份权益是幂等，不是冲突。哈希只覆盖会改变授权语义的四个字段
--    （`feature_key` / `enabled` / `quota_value` / `term_months`），**不含
--    `display_name_snapshot`**：改一个功能的显示名不等于改了授权，把展示名
--    算进哈希会让「同一个套餐改了文案」变成一次重新发放，历史里多出一堆
--    内容完全相同的快照。
--
-- 3. **变更申请是在「当前快照」上增量改，不是在「套餐默认权益」上改。**
--    这条决定了升级路径对不对：若以套餐为基线，客户已经单独加购的两个功能
--    在第一次「额度调整」之后会静默消失——因为申请表里只提交改动的项。
--    所以 `feature_lines_apply` 的基线由调用方给：新建订阅传套餐权益，
--    变更申请传当前快照的行。
--
-- 4. **`contract_items` 补 `UNIQUE(contract_id, id)`。** 订阅与授权都要断言
--    「条目属于这份合同」，与 billing 域「收款与应收同客户同币种」是同一类
--    问题：在 JS 里比两个 uuid 挡不住并发，复合外键是唯一能在表层成立的写法。
--    原表的 `UNIQUE(contract_id, line_no)` 不能当落点（id 不在里面）。
--
-- 5. **审计终于覆盖到权益。** o-t08 让 billing 落了九个词，本域再落二十四个：
--    订阅/授权各八个动作词 + 变更申请七个 + 快照一个。契约 §4 把
--    `entitlement.approve` / `entitlement.execute` 列为高风险动作，写审计是
--    硬要求；词表在 `packages/contracts/src/ops/audit-actions.ts` 同步补齐。
--
-- 6. **`deployment_instance_id` 与 `tenant_mapping` 是软引用。** `deployment_instances`
--    属 o-t11、`tenant_mappings` 属 o-t10，本轮都不存在。与合同域的
--    `contract_items.entitlement_snapshot_id` 同样处理：不加 FK，接口先返回
--    `null` 并把这个缺口登记到协作项，而不是在这里造一张替身表。
--
-- 7. **`tenant_commands` 不存在，所以 `suspend`/`resume`/`revoke` 下发不了命令。**
--    契约 §5.6 要求这三个动作返回 202 与 `command{id,status}`。命令表属 o-t10，
--    本轮如实返回 202 + `command: null`：状态确实已经变了、但租户侧还没同步，
--    这个「半完成」正是 202 的含义。不伪造一个假 id，也不把状态码改成 200 ——
--    后者会让 o-t10 落地时变成一次破坏性变更（前端已经按 200 写了分支）。
--
-- 8. **订阅审批不做职责分离，变更申请审批做。** 契约 §3.5 只给
--    `entitlement_change_requests` 写了 `CHECK(approved_by <> requested_by)`，
--    §6.4 的 `SEGREGATION_OF_DUTY` 也只点名「收款登记人自审、变更单申请人自批」。
--    订阅表结构上没有 `approved_by` 列，契约也没要求——不擅自加列、不擅自加
--    规则。变更申请那两列既有 CHECK 又在应用层回 403，与收款域同构。
-- ── 0. contract_items 补复合外键落点（见设计要点 4）─────────────────────────
ALTER TABLE ops.contract_items
ADD CONSTRAINT contract_items_contract_id_key UNIQUE (contract_id, id);


CREATE SEQUENCE ops.subscription_no_seq AS bigint START
WITH
  1;


CREATE SEQUENCE ops.license_no_seq AS bigint START
WITH
  1;


-- ── 1. 权益快照（见设计要点 1 / 2）──────────────────────────────────────────
CREATE TABLE ops.entitlement_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  source_type text NOT NULL CHECK (
    source_type IN ('contract_item', 'change_request')
  ),
  -- 多态来源：合同条目或变更申请。不加 FK——两张来源表在同一个域里，
  -- 加两个可空 FK 只会让「哪个必填」变成运行期才知道的事。
  source_id uuid NOT NULL,
  target_scope text NOT NULL CHECK (
    target_scope IN ('saas_tenant', 'private_instance')
  ),
  -- 目标租户 / 部署实例。两者属 o-t10 / o-t11，本轮软引用（见设计要点 6）。
  target_ref uuid,
  valid_from date,
  valid_to date,
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- sha256 十六进制恒为 64 字符。写死长度是为了让「算错了」当场失败，
  -- 而不是让一条 3 字符的哈希参与唯一约束、把每次发放都判成新快照。
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  CONSTRAINT entitlement_snapshots_source_hash_key UNIQUE (source_type, source_id, content_hash),
  CONSTRAINT entitlement_snapshots_period_check CHECK (
    valid_to IS NULL
    OR valid_from IS NULL
    OR valid_to >= valid_from
  )
);


CREATE INDEX entitlement_snapshots_customer_idx ON ops.entitlement_snapshots (customer_id, valid_from DESC);


CREATE INDEX entitlement_snapshots_valid_from_idx ON ops.entitlement_snapshots (valid_from DESC);


CREATE TABLE ops.entitlement_snapshot_lines (
  snapshot_id uuid NOT NULL REFERENCES ops.entitlement_snapshots (id) ON DELETE RESTRICT,
  feature_key text NOT NULL REFERENCES ops.feature_definitions (feature_key) ON DELETE RESTRICT,
  enabled boolean NOT NULL,
  quota_value numeric(14, 2) CHECK (
    quota_value IS NULL
    OR quota_value >= 0
  ),
  term_months integer CHECK (
    term_months IS NULL
    OR term_months > 0
  ),
  display_name_snapshot text NOT NULL CHECK (length(btrim(display_name_snapshot)) > 0),
  PRIMARY KEY (snapshot_id, feature_key)
);


-- 快照不可变：业务身份由 REVOKE 挡住，表属主由触发器挡住（见设计要点 1）。
CREATE OR REPLACE FUNCTION ops.entitlement_snapshot_immutable () returns trigger language plpgsql
SET
  search_path = '' AS $$
begin
  raise exception 'ops entitlement snapshots are append-only' using errcode = 'restrict_violation';
end;
$$;


CREATE TRIGGER entitlement_snapshots_immutable
BEFORE UPDATE OR DELETE ON ops.entitlement_snapshots FOR EACH ROW
EXECUTE FUNCTION ops.entitlement_snapshot_immutable ();


CREATE TRIGGER entitlement_snapshot_lines_immutable
BEFORE UPDATE OR DELETE ON ops.entitlement_snapshot_lines FOR EACH ROW
EXECUTE FUNCTION ops.entitlement_snapshot_immutable ();


-- ── 2. 订阅 ────────────────────────────────────────────────────────────────
CREATE TABLE ops.subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_no text NOT NULL DEFAULT (
    'SUB-' || lpad(nextval('ops.subscription_no_seq')::text, 6, '0')
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  contract_item_id uuid NOT NULL,
  -- 冗余自合同条目：订阅列表要按产品筛、要显示产品名，每次都回查条目会让
  -- 「条目被删」变成订阅页整行消失。值由 RPC 从条目抄，不接受调用方给。
  product_id uuid REFERENCES ops.products (id) ON DELETE RESTRICT,
  package_id uuid REFERENCES ops.packages (id) ON DELETE RESTRICT,
  billing_cycle text NOT NULL CHECK (
    billing_cycle IN ('monthly', 'quarterly', 'yearly', 'multi_year')
  ),
  starts_on date NOT NULL,
  ends_on date,
  auto_renew_intent boolean NOT NULL DEFAULT FALSE,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN (
      'draft',
      'pending_approval',
      'active',
      'suspended',
      'revoked',
      'expired'
    )
  ),
  -- 软引用，见设计要点 6（实际是同一次迁移里建的表，但顺序在前，可以直接加 FK）。
  current_snapshot_id uuid REFERENCES ops.entitlement_snapshots (id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT subscriptions_subscription_no_key UNIQUE (subscription_no),
  CONSTRAINT subscriptions_contract_item_fkey FOREIGN KEY (contract_id, contract_item_id) REFERENCES ops.contract_items (contract_id, id) ON DELETE RESTRICT,
  CONSTRAINT subscriptions_period_check CHECK (
    ends_on IS NULL
    OR ends_on >= starts_on
  )
);


CREATE INDEX subscriptions_status_idx ON ops.subscriptions (status, ends_on);


CREATE INDEX subscriptions_customer_idx ON ops.subscriptions (customer_id);


-- 「重复开通同条目」在这一层挡住（契约 §5.6 的 409 CONFLICT）。终态之后可以
-- 重新开通，所以是部分唯一索引而不是全表唯一约束——全表唯一会让「撤掉一次
-- 再重开」永久办不到，而那是换约与重新上线的正常路径。
CREATE UNIQUE INDEX subscriptions_open_item_key ON ops.subscriptions (contract_item_id)
WHERE
  status NOT IN ('revoked', 'expired');


-- ── 3. 私有化授权 ──────────────────────────────────────────────────────────
CREATE TABLE ops.private_licenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_no text NOT NULL DEFAULT (
    'LIC-' || lpad(nextval('ops.license_no_seq')::text, 6, '0')
  ),
  customer_id uuid NOT NULL REFERENCES ops.customers (id) ON DELETE RESTRICT,
  contract_id uuid NOT NULL REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  contract_item_id uuid NOT NULL,
  -- 软引用：deployment_instances 属 o-t11（见设计要点 6）。
  deployment_instance_id uuid,
  license_mode text NOT NULL CHECK (license_mode IN ('term', 'perpetual')),
  valid_from date NOT NULL,
  valid_to date,
  -- 维护期与授权期是两件事：契约 §3.5 的「永久授权不得推导为永久更新」
  -- 就是这个意思。永久授权 + 一年维护是完全正常的组合，所以这里不联动。
  maintenance_until date,
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN (
      'draft',
      'pending_approval',
      'active',
      'suspended',
      'revoked',
      'expired'
    )
  ),
  current_snapshot_id uuid REFERENCES ops.entitlement_snapshots (id) ON DELETE RESTRICT,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT private_licenses_license_no_key UNIQUE (license_no),
  CONSTRAINT private_licenses_contract_item_fkey FOREIGN KEY (contract_id, contract_item_id) REFERENCES ops.contract_items (contract_id, id) ON DELETE RESTRICT,
  -- 契约原文：`CHECK((license_mode='perpetual') = (valid_to IS NULL))`。
  -- 写成「同真同假」而不是两条单边约束，是因为两条单边约束允许「term + 无
  -- 有效期」通过——而那是 T-09 验收断言里明确要 400 的第二种错法。
  CONSTRAINT private_licenses_mode_period_check CHECK ((license_mode = 'perpetual') = (valid_to IS NULL)),
  CONSTRAINT private_licenses_valid_period_check CHECK (
    valid_to IS NULL
    OR valid_to >= valid_from
  ),
  CONSTRAINT private_licenses_maintenance_check CHECK (
    maintenance_until IS NULL
    OR maintenance_until >= valid_from
  )
);


CREATE INDEX private_licenses_status_idx ON ops.private_licenses (status, valid_to);


CREATE INDEX private_licenses_customer_idx ON ops.private_licenses (customer_id);


-- 一个部署实例同时只能有一份有效授权。合同的 `UNIQUE(license_no)` 只保证
-- 编号不重，挡不住「同一台机器被发了两次授权」。
CREATE UNIQUE INDEX private_licenses_open_instance_key ON ops.private_licenses (deployment_instance_id)
WHERE
  deployment_instance_id IS NOT NULL
  AND status NOT IN ('revoked', 'expired');


-- ── 4. 权益变更申请 ────────────────────────────────────────────────────────
CREATE TABLE ops.entitlement_change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('subscription', 'license')),
  subject_id uuid NOT NULL,
  change_type text NOT NULL CHECK (
    change_type IN (
      'issue',
      'extend',
      'upgrade',
      'downgrade',
      'quota_change',
      'suspend',
      'resume',
      'expire',
      'revoke'
    )
  ),
  source_contract_id uuid REFERENCES ops.contracts (id) ON DELETE RESTRICT,
  proposed_snapshot_id uuid REFERENCES ops.entitlement_snapshots (id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (
    status IN (
      'draft',
      'pending_approval',
      'approved',
      'executing',
      'executed',
      'failed',
      'rejected',
      'cancelled'
    )
  ),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  before_summary jsonb NOT NULL,
  after_summary jsonb NOT NULL,
  requested_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  approved_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  approved_at timestamptz,
  executed_at timestamptz,
  -- 软引用：tenant_commands 属 o-t10（见设计要点 7）。
  command_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entitlement_change_requests_duty_check CHECK (
    approved_by IS NULL
    OR requested_by IS NULL
    OR approved_by <> requested_by
  )
);


CREATE INDEX entitlement_change_requests_status_idx ON ops.entitlement_change_requests (status, created_at);


CREATE INDEX entitlement_change_requests_subject_idx ON ops.entitlement_change_requests (subject_type, subject_id);


-- ── 5. 状态机（契约 §3.5）─────────────────────────────────────────────────
-- 做成数据：详情回包的 `allowedActions`、非法迁移的 `details.allowedActions`、
-- 前端按钮三处共用同一个函数。订阅与授权共用一套动作集——契约 §3.5 也是一张
-- 表管两张表，唯一的差别（到期日取 `ends_on` 还是 `valid_to`）留在调用方。
CREATE OR REPLACE FUNCTION ops.allowed_subject_actions (p_status text) returns TEXT[] language sql immutable
SET
  search_path = '' AS $$
  select case p_status
    when 'draft' then array['submit']
    when 'pending_approval' then array['approve', 'reject']
    when 'active' then array['suspend', 'revoke', 'mark_expired']
    when 'suspended' then array['resume', 'revoke']
    else array[]::text[]
  end;
$$;


CREATE OR REPLACE FUNCTION ops.allowed_change_request_actions (p_status text) returns TEXT[] language sql immutable
SET
  search_path = '' AS $$
  select case p_status
    when 'draft' then array['submit', 'cancel']
    when 'pending_approval' then array['approve', 'reject', 'cancel']
    when 'approved' then array['execute', 'cancel']
    when 'failed' then array['retry', 'cancel']
    -- executing 只等系统落结果，executed / rejected / cancelled 是终态。
    else array[]::text[]
  end;
$$;


-- ── 6. 权益行的组装（见设计要点 3）─────────────────────────────────────────
-- 基线 1：套餐权益。新建订阅/授权时用。
CREATE OR REPLACE FUNCTION ops.feature_lines_base (p_package_id uuid, p_target_scope text) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'feature_key', feature.feature_key,
        'enabled', feature.enabled,
        'quota_value', feature.quota_value,
        'term_months', feature.term_months,
        'display_name_snapshot', definition.display_name
      )
      order by feature.feature_key
    ),
    '[]'::jsonb
  )
  from ops.package_features as feature
  join ops.feature_definitions as definition on definition.feature_key = feature.feature_key
  where feature.package_id = p_package_id
    and feature.applies_to in ('both', p_target_scope)
    and definition.is_active;
$$;


-- 基线 2：当前快照的行。变更申请时用（见设计要点 3）。
-- 两件事：套用增量的覆盖，以及拒绝三种坏输入。
--
-- 返回信封而不是抛异常：调用方要把「哪个 featureKey 不认识」原样变成 400 的
-- `details.featureKey`，前端才能把输入框标红。抛异常只能给一句 message。
CREATE OR REPLACE FUNCTION ops.feature_lines_apply (p_base jsonb, p_features jsonb) returns jsonb language plpgsql immutable
SET
  search_path = '' AS $$
declare
  base_map jsonb := '{}'::jsonb;
  merged jsonb := '{}'::jsonb;
  entry jsonb;
  target_key text;
  base_entry jsonb;
  quota numeric;
  term integer;
  enabled boolean;
  definition record;
  total_count integer;
  distinct_count integer;
begin
  if p_base is not null and jsonb_typeof(p_base) = 'array' then
    for entry in
      select value from jsonb_array_elements(p_base)
    loop
      merged := merged || jsonb_build_object(entry ->> 'feature_key', entry);
    end loop;
    base_map := merged;
  end if;

  if p_features is null or jsonb_typeof(p_features) <> 'array' then
    return jsonb_build_object('status', 'ok', 'lines', ops.feature_lines_sorted(base_map));
  end if;

  -- 同一个 featureKey 出现两次：后面那条会静默盖掉前面那条，而调用方以为
  -- 两条都生效了。在合并之前先拦。
  select count(*), count(distinct elem ->> 'featureKey')
  into total_count, distinct_count
  from jsonb_array_elements(p_features) as elem;

  if total_count <> distinct_count then
    return jsonb_build_object('status', 'feature_duplicate');
  end if;

  for entry in
    select value from jsonb_array_elements(p_features)
  loop
    target_key := btrim(coalesce(entry ->> 'featureKey', ''));
    if target_key = '' then
      return jsonb_build_object('status', 'feature_key_required');
    end if;

    select feature_key, display_name
    into definition
    from ops.feature_definitions
    where feature_key = target_key;

    if not found then
      return jsonb_build_object('status', 'feature_unknown', 'feature_key', target_key);
    end if;

    base_entry := base_map -> target_key;

    quota := null;
    term := null;

    if entry ? 'quotaValue' and jsonb_typeof(entry -> 'quotaValue') <> 'null' then
      quota := (entry ->> 'quotaValue')::numeric;
      if quota < 0 then
        return jsonb_build_object('status', 'feature_invalid', 'feature_key', target_key);
      end if;
    elsif base_entry is not null then
      quota := (base_entry ->> 'quota_value')::numeric;
    end if;

    if entry ? 'termMonths' and jsonb_typeof(entry -> 'termMonths') <> 'null' then
      term := (entry ->> 'termMonths')::integer;
      if term <= 0 then
        return jsonb_build_object('status', 'feature_invalid', 'feature_key', target_key);
      end if;
    elsif base_entry is not null then
      term := (base_entry ->> 'term_months')::integer;
    end if;

    if entry ? 'enabled' and jsonb_typeof(entry -> 'enabled') <> 'null' then
      enabled := (entry ->> 'enabled')::boolean;
    elsif base_entry is not null then
      enabled := (base_entry ->> 'enabled')::boolean;
    else
      enabled := true;
    end if;

    merged := merged || jsonb_build_object(
      target_key,
      jsonb_build_object(
        'feature_key', target_key,
        'enabled', enabled,
        'quota_value', quota,
        'term_months', term,
        -- 展示名一律取字典当前值，不接受调用方传：快照的意义是冻结「当时
        -- 字典怎么写的」，允许外部传入等于允许伪造证据。
        'display_name_snapshot', definition.display_name
      )
    );
  end loop;

  return jsonb_build_object('status', 'ok', 'lines', ops.feature_lines_sorted(merged));
end;
$$;


CREATE OR REPLACE FUNCTION ops.feature_lines_sorted (p_map jsonb) returns jsonb language sql immutable
SET
  search_path = '' AS $$
  select coalesce(jsonb_agg(value order by key), '[]'::jsonb) from jsonb_each(p_map);
$$;


-- ── 7. 快照的哈希与形状 ────────────────────────────────────────────────────
-- 只覆盖会改变授权语义的四个字段（见设计要点 2）。`-` 是「该字段为空」的
-- 占位符：用空串会让 `quota: null` 与 `quota: ''` 撞成同一个哈希，而后者不可能
-- 出现，前者很常见（布尔型功能没有额度）。
CREATE OR REPLACE FUNCTION ops.snapshot_content_hash (p_lines jsonb) returns text language sql immutable
SET
  search_path = '' AS $$
  select encode(
    sha256(
      convert_to(
        coalesce(
          string_agg(
            (line ->> 'feature_key')
            || '|' || coalesce(line ->> 'enabled', '')
            || '|' || coalesce(line ->> 'quota_value', '-')
            || '|' || coalesce(line ->> 'term_months', '-'),
            E'\n'
            order by line ->> 'feature_key'
          ),
          ''
        ),
        'UTF8'
      )
    ),
    'hex'
  )
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;
$$;


CREATE OR REPLACE FUNCTION ops.snapshot_lines_json (p_snapshot_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'feature_key', line.feature_key,
        'enabled', line.enabled,
        'quota_value', line.quota_value,
        'term_months', line.term_months,
        'display_name_snapshot', line.display_name_snapshot
      )
      order by line.feature_key
    ),
    '[]'::jsonb
  )
  from ops.entitlement_snapshot_lines as line
  where line.snapshot_id = p_snapshot_id;
$$;


-- 列表项：详情去掉 `lines` 后加 `line_count`（契约 §5.6 脚注）。
CREATE OR REPLACE FUNCTION ops.snapshot_summary_json (p_snapshot_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', snapshot.id,
    'customer_id', snapshot.customer_id,
    'source_type', snapshot.source_type,
    'source_id', snapshot.source_id,
    'target_scope', snapshot.target_scope,
    'target_ref', snapshot.target_ref,
    'valid_from', snapshot.valid_from,
    'valid_to', snapshot.valid_to,
    'content_hash', snapshot.content_hash,
    'line_count', (
      select count(*) from ops.entitlement_snapshot_lines as line
      where line.snapshot_id = snapshot.id
    ),
    'created_at', snapshot.created_at
  )
  from ops.entitlement_snapshots as snapshot
  where snapshot.id = p_snapshot_id;
$$;


CREATE OR REPLACE FUNCTION ops.snapshot_json (p_snapshot_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select case
    when summary.value is null then null
    else summary.value || jsonb_build_object('lines', ops.snapshot_lines_json(p_snapshot_id))
  end
  from (select ops.snapshot_summary_json(p_snapshot_id) as value) as summary;
$$;


-- ── 8. 订阅 / 授权的出站形状 ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.subject_json (p_subject_type text, p_subject_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  if p_subject_type = 'subscription' then
    select jsonb_build_object(
      'id', entry.id,
      'subscription_no', entry.subscription_no,
      'customer', jsonb_build_object(
        'id', customer.id,
        'customer_no', customer.customer_no,
        'name', customer.name
      ),
      'contract_id', entry.contract_id,
      'contract_no', contract.contract_no,
      'contract_item_id', entry.contract_item_id,
      'product', case
        when product.id is null then null
        else jsonb_build_object('id', product.id, 'code', product.code, 'name', product.name)
      end,
      'package', case
        when package.id is null then null
        else jsonb_build_object(
          'id', package.id,
          'internal_name', package.internal_name,
          'customer_name', package.customer_name
        )
      end,
      'billing_cycle', entry.billing_cycle,
      'starts_on', entry.starts_on,
      'ends_on', entry.ends_on,
      'auto_renew_intent', entry.auto_renew_intent,
      'status', entry.status,
      'current_snapshot_id', entry.current_snapshot_id,
      'snapshot', ops.snapshot_summary_json(entry.current_snapshot_id),
      'version', entry.version,
      'created_at', entry.created_at,
      'updated_at', entry.updated_at
    )
    into result
    from ops.subscriptions as entry
    join ops.customers as customer on customer.id = entry.customer_id
    join ops.contracts as contract on contract.id = entry.contract_id
    left join ops.products as product on product.id = entry.product_id
    left join ops.packages as package on package.id = entry.package_id
    where entry.id = p_subject_id;

    return result;
  end if;

  if p_subject_type = 'license' then
    select jsonb_build_object(
      'id', entry.id,
      'license_no', entry.license_no,
      'customer', jsonb_build_object(
        'id', customer.id,
        'customer_no', customer.customer_no,
        'name', customer.name
      ),
      'contract_id', entry.contract_id,
      'contract_no', contract.contract_no,
      'contract_item_id', entry.contract_item_id,
      'deployment_instance_id', entry.deployment_instance_id,
      'license_mode', entry.license_mode,
      'valid_from', entry.valid_from,
      'valid_to', entry.valid_to,
      'maintenance_until', entry.maintenance_until,
      'status', entry.status,
      'current_snapshot_id', entry.current_snapshot_id,
      'snapshot', ops.snapshot_summary_json(entry.current_snapshot_id),
      'version', entry.version,
      'created_at', entry.created_at,
      'updated_at', entry.updated_at
    )
    into result
    from ops.private_licenses as entry
    join ops.customers as customer on customer.id = entry.customer_id
    join ops.contracts as contract on contract.id = entry.contract_id
    where entry.id = p_subject_id;

    return result;
  end if;

  return null;
end;
$$;


CREATE OR REPLACE FUNCTION ops.change_request_json (p_change_request_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', request.id,
    'subject_type', request.subject_type,
    'subject_id', request.subject_id,
    'subject_no', case
      when request.subject_type = 'subscription' then (
        select subscription_no from ops.subscriptions where id = request.subject_id
      )
      else (
        select license_no from ops.private_licenses where id = request.subject_id
      )
    end,
    'change_type', request.change_type,
    'status', request.status,
    'source_contract_id', request.source_contract_id,
    'proposed_snapshot_id', request.proposed_snapshot_id,
    'proposed_snapshot', ops.snapshot_summary_json(request.proposed_snapshot_id),
    'reason', request.reason,
    'before_summary', request.before_summary,
    'after_summary', request.after_summary,
    'requested_by', ops.operator_ref(request.requested_by),
    'approved_by', ops.operator_ref(request.approved_by),
    'approved_at', request.approved_at,
    'executed_at', request.executed_at,
    'command_id', request.command_id,
    'version', request.version,
    'created_at', request.created_at,
    'updated_at', request.updated_at
  )
  from ops.entitlement_change_requests as request
  where request.id = p_change_request_id;
$$;


-- 前后差异。`changed` 只比三个语义字段，不比 `display_name_snapshot`：
-- 字典改了文案不算权益变更（与设计要点 2 的哈希口径一致，否则会出现
-- 「diff 说有变化、但哈希没变」的自相矛盾）。
CREATE OR REPLACE FUNCTION ops.change_request_diff (p_change_request_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  with before_map as (
    select coalesce(
      jsonb_object_agg(item.value ->> 'feature_key', item.value),
      '{}'::jsonb
    ) as map
    from ops.entitlement_change_requests as request
    cross join lateral jsonb_array_elements(
      coalesce(request.before_summary -> 'lines', '[]'::jsonb)
    ) as item
    where request.id = p_change_request_id
  ),
  after_map as (
    select coalesce(
      jsonb_object_agg(item.value ->> 'feature_key', item.value),
      '{}'::jsonb
    ) as map
    from ops.entitlement_change_requests as request
    cross join lateral jsonb_array_elements(
      coalesce(request.after_summary -> 'lines', '[]'::jsonb)
    ) as item
    where request.id = p_change_request_id
  ),
  -- 摊平成一行，避免下面每个聚合各写一次子查询。`?` 与 `NOT` 的优先级写法
  -- 容易读错（`not x ? y` 到底是谁先算），所以一律加括号。
  maps as (
    select (select map from before_map) as before_side,
           (select map from after_map) as after_side
  )
  select jsonb_build_object(
    'before', (
      select coalesce(before_summary, '{}'::jsonb)
      from ops.entitlement_change_requests where id = p_change_request_id
    ),
    'after', (
      select coalesce(after_summary, '{}'::jsonb)
      from ops.entitlement_change_requests where id = p_change_request_id
    ),
    'added', coalesce((
      select jsonb_agg(after_entry.value order by after_entry.key)
      from maps
      cross join lateral jsonb_each(maps.after_side) as after_entry
      where not (maps.before_side ? after_entry.key)
    ), '[]'::jsonb),
    'removed', coalesce((
      select jsonb_agg(before_entry.value order by before_entry.key)
      from maps
      cross join lateral jsonb_each(maps.before_side) as before_entry
      where not (maps.after_side ? before_entry.key)
    ), '[]'::jsonb),
    'changed', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'feature_key', before_entry.key,
          'before', before_entry.value,
          'after', maps.after_side -> before_entry.key
        )
        order by before_entry.key
      )
      from maps
      cross join lateral jsonb_each(maps.before_side) as before_entry
      where (maps.after_side ? before_entry.key)
        and (before_entry.value - 'display_name_snapshot')
          is distinct from ((maps.after_side -> before_entry.key) - 'display_name_snapshot')
    ), '[]'::jsonb)
  );
$$;


-- ── 9. 发放快照 ────────────────────────────────────────────────────────────
-- 命中同一份内容就返回既有的那张（见设计要点 2）。返回 id 而不是整行，
-- 因为调用方紧接着要拿它写 `current_snapshot_id`。
CREATE OR REPLACE FUNCTION ops.create_snapshot (
  p_customer_id uuid,
  p_source_type text,
  p_source_id uuid,
  p_target_scope text,
  p_target_ref uuid,
  p_valid_from date,
  p_valid_to date,
  p_lines jsonb
) returns uuid language plpgsql security definer
SET
  search_path = '' AS $$
declare
  new_hash text;
  existing_id uuid;
  new_id uuid := gen_random_uuid();
  actor_id uuid := ops.current_operator_id();
begin
  new_hash := ops.snapshot_content_hash(p_lines);

  select snapshot.id
  into existing_id
  from ops.entitlement_snapshots as snapshot
  where snapshot.source_type = p_source_type
    and snapshot.source_id = p_source_id
    and snapshot.content_hash = new_hash;

  if found then
    return existing_id;
  end if;

  insert into ops.entitlement_snapshots (
    id, customer_id, source_type, source_id, target_scope, target_ref,
    valid_from, valid_to, created_by, content_hash
  )
  values (
    new_id, p_customer_id, p_source_type, p_source_id, p_target_scope, p_target_ref,
    p_valid_from, p_valid_to, actor_id, new_hash
  );

  insert into ops.entitlement_snapshot_lines (
    snapshot_id, feature_key, enabled, quota_value, term_months, display_name_snapshot
  )
  select new_id, line.feature_key, line.enabled, line.quota_value, line.term_months,
    line.display_name_snapshot
  from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb)) as line(
    feature_key text,
    enabled boolean,
    quota_value numeric,
    term_months integer,
    display_name_snapshot text
  );

  perform ops.write_audit(
    'entitlement_snapshot.created',
    'entitlement_snapshot',
    new_id,
    null,
    null,
    jsonb_build_object(
      'sourceType', p_source_type,
      'sourceId', p_source_id,
      'targetScope', p_target_scope,
      'contentHash', new_hash,
      'lineCount', (select count(*) from ops.entitlement_snapshot_lines where snapshot_id = new_id)
    )
  );

  return new_id;
end;
$$;


-- ── 10. 新建订阅 ───────────────────────────────────────────────────────────
-- 合同可用的两种状态（契约 §3.5 的 create_draft 守卫）：已生效，或已签署且
-- 生效日不晚于今天。「已签署但生效日在明天」不能开通——否则订阅的起始日会
-- 落在合同生效之前，而应收计划是按合同生效日生成的，两边对不上。
CREATE OR REPLACE FUNCTION ops.entitlement_contract_status_allows (p_status text, p_effective_on date) returns boolean language sql immutable
SET
  search_path = '' AS $$
  select p_status = 'active'
    or (p_status = 'signed' and p_effective_on is not null and p_effective_on <= current_date);
$$;


CREATE OR REPLACE FUNCTION ops.create_subscription (
  p_customer_id uuid,
  p_contract_item_id uuid,
  p_billing_cycle text,
  p_starts_on date,
  p_ends_on date DEFAULT NULL,
  p_auto_renew_intent boolean DEFAULT FALSE,
  p_features jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  item record;
  built jsonb;
  snapshot_id uuid;
  new_id uuid;
begin
  perform ops.require_permission('entitlement.request');

  select
    entry.id,
    entry.contract_id,
    entry.sales_mode,
    entry.product_id,
    entry.package_id,
    contract.customer_id as contract_customer_id,
    contract.status as contract_status,
    contract.effective_on as contract_effective_on,
    contract.currency as contract_currency
  into item
  from ops.contract_items as entry
  join ops.contracts as contract on contract.id = entry.contract_id
  where entry.id = p_contract_item_id;

  if not found then
    return jsonb_build_object('status', 'contract_item_not_found');
  end if;

  if item.contract_customer_id <> p_customer_id then
    return jsonb_build_object(
      'status', 'customer_mismatch',
      'contract_customer_id', item.contract_customer_id
    );
  end if;

  if not ops.entitlement_contract_status_allows(item.contract_status, item.contract_effective_on) then
    return jsonb_build_object('status', 'contract_not_active', 'contract_status', item.contract_status);
  end if;

  -- 订阅只能落在 saas 条目上。授权（private）走 create_license：两者的目标
  -- 作用域、有效期语义、下发对象都不同，混在一张表里会让「这台机器的授权
  -- 到期了」和「这个租户的订阅到期了」变成同一个查询。
  if item.sales_mode <> 'saas' then
    return jsonb_build_object('status', 'sales_mode_mismatch', 'sales_mode', item.sales_mode);
  end if;

  if p_billing_cycle is null or p_billing_cycle not in ('monthly', 'quarterly', 'yearly', 'multi_year') then
    return jsonb_build_object('status', 'invalid_billing_cycle');
  end if;

  if p_starts_on is null then
    return jsonb_build_object('status', 'start_date_required');
  end if;

  if p_ends_on is not null and p_ends_on < p_starts_on then
    return jsonb_build_object('status', 'invalid_period');
  end if;

  -- 先判重复再建快照：反过来的话，每一次「重复开通」的失败尝试都会留下一张
  -- 孤儿快照，而快照是不可删的。
  if exists (
    select 1 from ops.subscriptions as entry
    where entry.contract_item_id = p_contract_item_id
      and entry.status not in ('revoked', 'expired')
  ) then
    return jsonb_build_object('status', 'duplicate_subscription');
  end if;

  built := ops.feature_lines_apply(
    ops.feature_lines_base(item.package_id, 'saas_tenant'),
    p_features
  );
  if built ->> 'status' <> 'ok' then
    return built;
  end if;

  snapshot_id := ops.create_snapshot(
    p_customer_id, 'contract_item', item.id, 'saas_tenant', null,
    p_starts_on, p_ends_on, built -> 'lines'
  );

  insert into ops.subscriptions (
    customer_id, contract_id, contract_item_id, product_id, package_id,
    billing_cycle, starts_on, ends_on, auto_renew_intent, status,
    current_snapshot_id, created_by, updated_by
  )
  values (
    p_customer_id, item.contract_id, item.id, item.product_id, item.package_id,
    p_billing_cycle, p_starts_on, p_ends_on, coalesce(p_auto_renew_intent, FALSE), 'draft',
    snapshot_id, actor_id, actor_id
  )
  returning id into new_id;

  perform ops.write_audit(
    'subscription.created',
    'subscription',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'subscriptionNo', (select subscription_no from ops.subscriptions where id = new_id),
      'customerId', p_customer_id,
      'contractItemId', p_contract_item_id,
      'billingCycle', p_billing_cycle,
      'currentSnapshotId', snapshot_id,
      'status', 'draft'
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'subscription', ops.subject_json('subscription', new_id),
    'snapshot', ops.snapshot_summary_json(snapshot_id)
  );
end;
$$;


-- ── 11. 新建私有化授权 ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_license (
  p_customer_id uuid,
  p_contract_item_id uuid,
  p_deployment_instance_id uuid DEFAULT NULL,
  p_license_mode text DEFAULT NULL,
  p_valid_from date DEFAULT NULL,
  p_valid_to date DEFAULT NULL,
  p_maintenance_until date DEFAULT NULL,
  p_features jsonb DEFAULT NULL,
  p_reason text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  item record;
  built jsonb;
  snapshot_id uuid;
  new_id uuid;
begin
  perform ops.require_permission('entitlement.request');

  select
    entry.id,
    entry.contract_id,
    entry.sales_mode,
    entry.package_id,
    contract.customer_id as contract_customer_id,
    contract.status as contract_status,
    contract.effective_on as contract_effective_on
  into item
  from ops.contract_items as entry
  join ops.contracts as contract on contract.id = entry.contract_id
  where entry.id = p_contract_item_id;

  if not found then
    return jsonb_build_object('status', 'contract_item_not_found');
  end if;

  if item.contract_customer_id <> p_customer_id then
    return jsonb_build_object(
      'status', 'customer_mismatch',
      'contract_customer_id', item.contract_customer_id
    );
  end if;

  if not ops.entitlement_contract_status_allows(item.contract_status, item.contract_effective_on) then
    return jsonb_build_object('status', 'contract_not_active', 'contract_status', item.contract_status);
  end if;

  if item.sales_mode <> 'private' then
    return jsonb_build_object('status', 'sales_mode_mismatch', 'sales_mode', item.sales_mode);
  end if;

  if p_license_mode is null or p_license_mode not in ('term', 'perpetual') then
    return jsonb_build_object('status', 'invalid_license_mode');
  end if;

  -- `p_valid_from` 在这张表上是 NOT NULL，给默认值只是为了能跳过前面的
  -- `p_deployment_instance_id`（Postgres 不允许「有默认值之后再跟无默认值」）。
  -- 所以这里必须显式挡一下，否则绕过接口直接调 RPC 会拿到 23502。
  if p_valid_from is null then
    return jsonb_build_object('status', 'valid_from_required');
  end if;

  -- T-09 的两条验收断言：永久授权带 valid_to → 400；反向（term 无 valid_to）
  -- 同样 400。表上有 CHECK 兜底，但那只会抛 23514，说不出是哪一种错。
  if p_license_mode = 'perpetual' and p_valid_to is not null then
    return jsonb_build_object('status', 'perpetual_with_valid_to');
  end if;

  if p_license_mode = 'term' and p_valid_to is null then
    return jsonb_build_object('status', 'term_requires_valid_to');
  end if;

  if p_valid_to is not null and p_valid_to < p_valid_from then
    return jsonb_build_object('status', 'invalid_period');
  end if;

  if p_maintenance_until is not null and p_maintenance_until < p_valid_from then
    return jsonb_build_object('status', 'invalid_maintenance_period');
  end if;

  if p_deployment_instance_id is not null and exists (
    select 1 from ops.private_licenses as entry
    where entry.deployment_instance_id = p_deployment_instance_id
      and entry.status not in ('revoked', 'expired')
  ) then
    return jsonb_build_object('status', 'duplicate_license');
  end if;

  built := ops.feature_lines_apply(
    ops.feature_lines_base(item.package_id, 'private_instance'),
    p_features
  );
  if built ->> 'status' <> 'ok' then
    return built;
  end if;

  snapshot_id := ops.create_snapshot(
    p_customer_id, 'contract_item', item.id, 'private_instance', p_deployment_instance_id,
    p_valid_from, p_valid_to, built -> 'lines'
  );

  insert into ops.private_licenses (
    customer_id, contract_id, contract_item_id, deployment_instance_id,
    license_mode, valid_from, valid_to, maintenance_until, status,
    current_snapshot_id, created_by, updated_by
  )
  values (
    p_customer_id, item.contract_id, item.id, p_deployment_instance_id,
    p_license_mode, p_valid_from, p_valid_to, p_maintenance_until, 'draft',
    snapshot_id, actor_id, actor_id
  )
  returning id into new_id;

  perform ops.write_audit(
    'license.created',
    'license',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'licenseNo', (select license_no from ops.private_licenses where id = new_id),
      'customerId', p_customer_id,
      'contractItemId', p_contract_item_id,
      'licenseMode', p_license_mode,
      'currentSnapshotId', snapshot_id,
      'status', 'draft'
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'license', ops.subject_json('license', new_id),
    'snapshot', ops.snapshot_summary_json(snapshot_id)
  );
end;
$$;


-- ── 12. 订阅 / 授权的状态迁移 ──────────────────────────────────────────────
-- 两张表一套逻辑：动作集相同（§3.5 就是一张表管两边），差别只在到期日取哪一列。
--
-- 权限按动作判，不按端点判（契约 §5.6 的「按 action 映射」）：一个端点三种权限，
-- 若先 require 一个固定权限，`approve` 会被 `entitlement.request` 挡住而
-- `submit` 又能被 `entitlement.execute` 放行——两种错都是静默的。
CREATE OR REPLACE FUNCTION ops.transition_entitlement_subject (
  p_subject_type text,
  p_subject_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  subscription_row ops.subscriptions;
  license_row ops.private_licenses;
  current_status text;
  current_version integer;
  expiry_date date;
  next_status text;
  action_permission text;
  audit_action text;
begin
  if p_subject_type not in ('subscription', 'license') then
    return jsonb_build_object('status', 'invalid_subject_type');
  end if;

  action_permission := case
    when p_action = 'submit' then 'entitlement.request'
    when p_action in ('approve', 'reject') then 'entitlement.approve'
    when p_action in ('suspend', 'resume', 'revoke', 'mark_expired') then 'entitlement.execute'
    else null
  end;

  if action_permission is null then
    return jsonb_build_object('status', 'invalid_action');
  end if;

  perform ops.require_permission(action_permission);

  if p_subject_type = 'subscription' then
    select * into subscription_row
    from ops.subscriptions as entry
    where entry.id = p_subject_id
    for update;

    if not found then
      return jsonb_build_object('status', 'subscription_not_found');
    end if;

    current_status := subscription_row.status;
    current_version := subscription_row.version;
    expiry_date := subscription_row.ends_on;
  else
    select * into license_row
    from ops.private_licenses as entry
    where entry.id = p_subject_id
    for update;

    if not found then
      return jsonb_build_object('status', 'license_not_found');
    end if;

    current_status := license_row.status;
    current_version := license_row.version;
    expiry_date := license_row.valid_to;
  end if;

  if p_expected_version is not null and p_expected_version <> current_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', current_version);
  end if;

  if not (p_action = any (ops.allowed_subject_actions(current_status))) then
    -- 契约 §3.5：未审批即下发 → 409 APPROVAL_REQUIRED，而不是「动作不存在」。
    -- 两者的用户下一步不同：前者去催审批，后者是点错了按钮。
    if p_action in ('suspend', 'resume', 'revoke', 'mark_expired')
      and current_status in ('draft', 'pending_approval') then
      return jsonb_build_object(
        'status', 'approval_required',
        'current_status', current_status
      );
    end if;

    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', current_status,
      'allowed_actions', ops.allowed_subject_actions(current_status)
    );
  end if;

  if p_action = 'submit' then
    -- 契约 §3.5 的守卫原文是「必须有 proposed_snapshot_id」。订阅/授权表上
    -- 只有 `current_snapshot_id`（快照在草案时就已经发放），所以判它。
    if p_subject_type = 'subscription' and subscription_row.current_snapshot_id is null then
      return jsonb_build_object('status', 'snapshot_required');
    end if;
    if p_subject_type = 'license' and license_row.current_snapshot_id is null then
      return jsonb_build_object('status', 'snapshot_required');
    end if;

    next_status := 'pending_approval';
    audit_action := 'submitted';
  elsif p_action = 'approve' then
    next_status := 'active';
    audit_action := 'approved';
  elsif p_action = 'reject' then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('status', 'reason_required');
    end if;
    -- 驳回回到 draft（契约 §3.5），不是回到终态：申请人是被要求改内容重提。
    next_status := 'draft';
    audit_action := 'rejected';
  elsif p_action = 'suspend' then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('status', 'reason_required');
    end if;
    next_status := 'suspended';
    audit_action := 'suspended';
  elsif p_action = 'resume' then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('status', 'reason_required');
    end if;
    next_status := 'active';
    audit_action := 'resumed';
  elsif p_action = 'revoke' then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('status', 'reason_required');
    end if;
    next_status := 'revoked';
    audit_action := 'revoked';
  else
    -- mark_expired。契约 §3.5 的守卫是 `valid_to < today`；今天之后到期的
    -- 不是「已经过期」，是「还没到」——直接标过期等于提前掐断客户的授权。
    if expiry_date is null or expiry_date >= current_date then
      return jsonb_build_object('status', 'not_expired', 'expiry_date', expiry_date);
    end if;
    next_status := 'expired';
    audit_action := 'expired';
  end if;

  if p_subject_type = 'subscription' then
    update ops.subscriptions
    set status = next_status,
        version = version + 1,
        updated_at = now(),
        updated_by = actor_id
    where id = p_subject_id;
  else
    update ops.private_licenses
    set status = next_status,
        version = version + 1,
        updated_at = now(),
        updated_by = actor_id
    where id = p_subject_id;
  end if;

  perform ops.write_audit(
    p_subject_type || '.' || audit_action,
    p_subject_type,
    p_subject_id,
    p_reason,
    jsonb_build_object('status', current_status),
    jsonb_build_object('status', next_status)
  );

  return jsonb_build_object(
    'status', 'ok',
    p_subject_type, ops.subject_json(p_subject_type, p_subject_id)
  );
end;
$$;


-- ── 13. 提交权益变更申请 ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_entitlement_change_request (
  p_subject_type text,
  p_subject_id uuid,
  p_change_type text,
  p_reason text,
  p_proposed_features jsonb DEFAULT NULL,
  p_effective_on date DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  subject_status text;
  subject_customer_id uuid;
  subject_contract_id uuid;
  subject_scope text;
  subject_ref uuid;
  current_snapshot_id uuid;
  subject_valid_from date;
  subject_valid_to date;
  before_lines jsonb;
  built jsonb;
  new_id uuid := gen_random_uuid();
  snapshot_id uuid;
begin
  perform ops.require_permission('entitlement.request');

  if p_subject_type not in ('subscription', 'license') then
    return jsonb_build_object('status', 'invalid_subject_type');
  end if;

  if p_change_type not in (
    'issue', 'extend', 'upgrade', 'downgrade', 'quota_change',
    'suspend', 'resume', 'expire', 'revoke'
  ) then
    return jsonb_build_object('status', 'invalid_change_type');
  end if;

  if p_reason is null or length(btrim(p_reason)) = 0 then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if p_subject_type = 'subscription' then
    select entry.status, entry.customer_id, entry.contract_id, entry.current_snapshot_id,
      entry.starts_on, entry.ends_on
    into subject_status, subject_customer_id, subject_contract_id, current_snapshot_id,
      subject_valid_from, subject_valid_to
    from ops.subscriptions as entry
    where entry.id = p_subject_id;

    subject_scope := 'saas_tenant';
    subject_ref := null;

    if not found then
      return jsonb_build_object('status', 'subscription_not_found');
    end if;
  else
    select entry.status, entry.customer_id, entry.contract_id, entry.current_snapshot_id,
      entry.valid_from, entry.valid_to
    into subject_status, subject_customer_id, subject_contract_id, current_snapshot_id,
      subject_valid_from, subject_valid_to
    from ops.private_licenses as entry
    where entry.id = p_subject_id;

    subject_scope := 'private_instance';

    if not found then
      return jsonb_build_object('status', 'license_not_found');
    end if;

    select entry.deployment_instance_id into subject_ref
    from ops.private_licenses as entry
    where entry.id = p_subject_id;
  end if;

  -- 契约 §5.6：订阅/授权非 active/suspended 时不许开变更单。草案阶段的
  -- 调整应该直接改草案，而不是先批一次变更再改。
  if subject_status not in ('active', 'suspended') then
    return jsonb_build_object('status', 'subject_not_active', 'current_status', subject_status);
  end if;

  if current_snapshot_id is null then
    before_lines := '[]'::jsonb;
  else
    before_lines := ops.snapshot_lines_json(current_snapshot_id);
  end if;

  built := ops.feature_lines_apply(before_lines, p_proposed_features);
  if built ->> 'status' <> 'ok' then
    return built;
  end if;

  snapshot_id := ops.create_snapshot(
    subject_customer_id, 'change_request', new_id, subject_scope, subject_ref,
    coalesce(p_effective_on, current_date), subject_valid_to, built -> 'lines'
  );

  insert into ops.entitlement_change_requests (
    id, subject_type, subject_id, change_type, source_contract_id,
    proposed_snapshot_id, status, reason, before_summary, after_summary,
    requested_by
  )
  values (
    new_id, p_subject_type, p_subject_id, p_change_type, subject_contract_id,
    snapshot_id, 'pending_approval', btrim(p_reason),
    jsonb_build_object('lines', before_lines),
    jsonb_build_object('lines', built -> 'lines'),
    actor_id
  );

  perform ops.write_audit(
    'entitlement_change.requested',
    'entitlement_change',
    new_id,
    btrim(p_reason),
    jsonb_build_object('lines', before_lines),
    jsonb_build_object(
      'changeType', p_change_type,
      'status', 'pending_approval',
      'proposedSnapshotId', snapshot_id,
      'lines', built -> 'lines'
    )
  );

  return jsonb_build_object(
    'status', 'ok',
    'change_request', ops.change_request_json(new_id),
    'diff', ops.change_request_diff(new_id)
  );
end;
$$;


-- ── 14. 变更申请的审核与执行 ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.transition_entitlement_change_request (
  p_change_request_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.entitlement_change_requests;
  next_status text;
  apply_snapshot boolean := FALSE;
begin
  select * into target
  from ops.entitlement_change_requests as entry
  where entry.id = p_change_request_id
  for update;

  if not found then
    return jsonb_build_object('status', 'change_request_not_found');
  end if;

  if p_action not in ('submit', 'approve', 'reject', 'execute', 'retry', 'cancel') then
    return jsonb_build_object('status', 'invalid_action');
  end if;

  -- 权限先判，且 cancel 是唯一一个「两个权限之一即可」的动作（契约 §3.5：
  -- `entitlement.request` 或 `entitlement.approve`）。require_permission 只能
  -- 表达「必须同时具备」，所以这里自己判并抛同样的 42501。
  if p_action in ('approve', 'reject') then
    perform ops.require_permission('entitlement.approve');
  elsif p_action = 'cancel' then
    if not (
      (select ops.has_permission('entitlement.request'))
      or (select ops.has_permission('entitlement.approve'))
    ) then
      raise exception 'ops permission denied: entitlement.request or entitlement.approve'
        using errcode = '42501';
    end if;
  elsif p_action = 'retry' then
    -- 契约 §5.6：`retry` 另需 `tenant.retry`。
    perform ops.require_permission('entitlement.execute');
    perform ops.require_permission('tenant.retry');
  else
    perform ops.require_permission('entitlement.execute');
  end if;

  if p_expected_version is not null and p_expected_version <> target.version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  if not (p_action = any (ops.allowed_change_request_actions(target.status))) then
    -- 契约 §6.4：未审批即执行 → APPROVAL_REQUIRED。T-09 的第二条验收断言
    -- 走的就是这条路（草案订阅直接下发）。
    if p_action in ('execute', 'retry') and target.status in ('draft', 'pending_approval') then
      return jsonb_build_object('status', 'approval_required', 'current_status', target.status);
    end if;

    return jsonb_build_object(
      'status', 'invalid_transition',
      'current_status', target.status,
      'allowed_actions', ops.allowed_change_request_actions(target.status)
    );
  end if;

  if p_action = 'approve' then
    -- 变更单申请人自批（契约 §3.4 receipts 同款，§6.4 点名）。表上有 CHECK
    -- 兜底，应用层这一条是为了给出 403 + rule，而不是让 23514 冒到前端。
    if target.requested_by is not null and target.requested_by = actor_id then
      return jsonb_build_object('status', 'segregation_of_duty');
    end if;

    next_status := 'approved';
  elsif p_action = 'reject' then
    if p_reason is null or length(btrim(p_reason)) = 0 then
      return jsonb_build_object('status', 'reason_required');
    end if;
    next_status := 'rejected';
  elsif p_action = 'cancel' then
    next_status := 'cancelled';
  elsif p_action = 'submit' then
    next_status := 'pending_approval';
  else
    -- execute / retry：直接落到 executed。契约 §3.5 的 `executing` 是给
    -- 「等租户命令回执」用的中间态，而命令表属 o-t10（见设计要点 7）；
    -- 命令不存在时停在 executing 会让这张单子永远不结束。
    next_status := 'executed';
    apply_snapshot := TRUE;
  end if;

  update ops.entitlement_change_requests
  set status = next_status,
      version = version + 1,
      updated_at = now(),
      approved_by = case when p_action = 'approve' then actor_id else approved_by end,
      approved_at = case when p_action = 'approve' then now() else approved_at end,
      executed_at = case when apply_snapshot then now() else executed_at end
  where id = p_change_request_id;

  if apply_snapshot then
    perform ops.apply_change_request_snapshot(p_change_request_id);
  end if;

  perform ops.write_audit(
    'entitlement_change.' || case
      when p_action = 'submit' then 'requested'
      when p_action = 'approve' then 'approved'
      when p_action = 'reject' then 'rejected'
      when p_action = 'cancel' then 'cancelled'
      when p_action = 'retry' then 'retried'
      else 'executed'
    end,
    'entitlement_change',
    p_change_request_id,
    p_reason,
    jsonb_build_object('status', target.status),
    jsonb_build_object('status', next_status, 'changeType', target.change_type)
  );

  return jsonb_build_object(
    'status', 'ok',
    'change_request', ops.change_request_json(p_change_request_id),
    'diff', ops.change_request_diff(p_change_request_id)
  );
end;
$$;


-- 执行：换快照 + 按变更类型改主体状态。
--
-- 只有四种变更类型会动状态（suspend / resume / expire / revoke），其余五种
-- （issue / extend / upgrade / downgrade / quota_change）只换快照——「延期」
-- 改的是快照里的 term 与主体的到期日，不该顺手把状态从 suspended 拉回 active。
CREATE OR REPLACE FUNCTION ops.apply_change_request_snapshot (p_change_request_id uuid) returns void language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.entitlement_change_requests;
  actor_id uuid := ops.current_operator_id();
  next_status text;
begin
  select * into target
  from ops.entitlement_change_requests as entry
  where entry.id = p_change_request_id;

  if not found then
    return;
  end if;

  next_status := case target.change_type
    when 'suspend' then 'suspended'
    when 'resume' then 'active'
    when 'expire' then 'expired'
    when 'revoke' then 'revoked'
    else null
  end;

  if target.subject_type = 'subscription' then
    update ops.subscriptions
    set current_snapshot_id = coalesce(target.proposed_snapshot_id, current_snapshot_id),
        status = coalesce(next_status, status),
        version = version + 1,
        updated_at = now(),
        updated_by = actor_id
    where id = target.subject_id;
  else
    update ops.private_licenses
    set current_snapshot_id = coalesce(target.proposed_snapshot_id, current_snapshot_id),
        status = coalesce(next_status, status),
        version = version + 1,
        updated_at = now(),
        updated_by = actor_id
    where id = target.subject_id;
  end if;
end;
$$;


-- ── 15. 读：订阅 ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_subscriptions (
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_product_id uuid DEFAULT NULL,
  p_expiring_in_days integer DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('entitlement.read');

  with filtered as (
    select entry.*
    from ops.subscriptions as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
      and (p_product_id is null or entry.product_id = p_product_id)
      -- `expiringInDays` 只找「还没到期、但快到期」的：已过期的不算临期，
      -- 否则临期清单里会永远堆着历史数据，而它是总览唯一会被追问的数字。
      and (
        p_expiring_in_days is null
        or (
          entry.ends_on is not null
          and entry.ends_on >= current_date
          and entry.ends_on <= current_date + p_expiring_in_days
        )
      )
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.starts_on desc, filtered.subscription_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.subject_json('subscription', page.id) order by
          filtered.starts_on desc, filtered.subscription_no desc, filtered.id
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


CREATE OR REPLACE FUNCTION ops.get_subscription (p_subscription_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  subject jsonb;
  snapshot jsonb;
  requests jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('entitlement.read');

  subject := ops.subject_json('subscription', p_subscription_id);
  if subject is null then
    return jsonb_build_object('status', 'subscription_not_found');
  end if;

  snapshot := ops.snapshot_json((subject ->> 'current_snapshot_id')::uuid);

  select coalesce(
    jsonb_agg(ops.change_request_json(entry.id) order by entry.created_at desc, entry.id),
    '[]'::jsonb
  )
  into requests
  from ops.entitlement_change_requests as entry
  where entry.subject_type = 'subscription'
    and entry.subject_id = p_subscription_id;

  return jsonb_build_object(
    'status', 'ok',
    'subscription', subject,
    'snapshot', snapshot,
    'change_requests', requests,
    -- 契约 §5.6 的 `tenantMapping?`。租户映射属 o-t10，本轮如实返回 null。
    'tenant_mapping', null
  );
end;
$$;


-- ── 16. 读：授权 ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_licenses (
  p_customer_id uuid DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_expiring_in_days integer DEFAULT NULL,
  p_deployment_instance_id uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('entitlement.read');

  with filtered as (
    select entry.*
    from ops.private_licenses as entry
    where (p_customer_id is null or entry.customer_id = p_customer_id)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or entry.status = any (p_statuses)
      )
      and (
        p_deployment_instance_id is null
        or entry.deployment_instance_id = p_deployment_instance_id
      )
      -- 永久授权没有 valid_to，永远不进临期清单——这正是「永久」的含义。
      and (
        p_expiring_in_days is null
        or (
          entry.valid_to is not null
          and entry.valid_to >= current_date
          and entry.valid_to <= current_date + p_expiring_in_days
        )
      )
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.valid_from desc, filtered.license_no desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.subject_json('license', page.id) order by
          filtered.valid_from desc, filtered.license_no desc, filtered.id
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


CREATE OR REPLACE FUNCTION ops.get_license (p_license_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  subject jsonb;
  snapshot jsonb;
  requests jsonb := '[]'::jsonb;
begin
  perform ops.require_permission('entitlement.read');

  subject := ops.subject_json('license', p_license_id);
  if subject is null then
    return jsonb_build_object('status', 'license_not_found');
  end if;

  snapshot := ops.snapshot_json((subject ->> 'current_snapshot_id')::uuid);

  select coalesce(
    jsonb_agg(ops.change_request_json(entry.id) order by entry.created_at desc, entry.id),
    '[]'::jsonb
  )
  into requests
  from ops.entitlement_change_requests as entry
  where entry.subject_type = 'license'
    and entry.subject_id = p_license_id;

  return jsonb_build_object(
    'status', 'ok',
    'license', subject,
    'snapshot', snapshot,
    'change_requests', requests,
    -- 契约 §5.6 的 `deployment?`。部署台账属 o-t11，本轮返回 null。
    'deployment', null
  );
end;
$$;


-- ── 17. 读：快照 ───────────────────────────────────────────────────────────
-- 契约 §5.6 的筛选参数是 `subjectType` + `subjectId`，而快照表上没有「主体」
-- 列（它的来源是合同条目或变更申请）。所以按主体筛选要翻译成两条路径：
-- 主体当前指向的那张，以及该主体名下所有变更申请产生的那些。翻译放在这里
-- 而不是接口层，是因为「快照属于哪个主体」只有数据库知道。
CREATE OR REPLACE FUNCTION ops.list_entitlement_snapshots (
  p_subject_type text DEFAULT NULL,
  p_subject_id uuid DEFAULT NULL,
  p_valid_from_from date DEFAULT NULL,
  p_valid_from_to date DEFAULT NULL,
  p_source_type text DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('entitlement.read');

  with filtered as (
    select snapshot.*
    from ops.entitlement_snapshots as snapshot
    where (p_source_type is null or snapshot.source_type = p_source_type)
      and (p_valid_from_from is null or snapshot.valid_from >= p_valid_from_from)
      and (p_valid_from_to is null or snapshot.valid_from <= p_valid_from_to)
      and (
        p_subject_type is null
        or p_subject_id is null
        or snapshot.id = case p_subject_type
          when 'subscription' then (
            select current_snapshot_id from ops.subscriptions where id = p_subject_id
          )
          else (
            select current_snapshot_id from ops.private_licenses where id = p_subject_id
          )
        end
        -- 最初那张：按合同条目发放的。少了这一条，订阅跑完第一次变更之后
        -- 「快照历史」里就看不到它最初拿到的是什么权益了，而那正是审计最常
        -- 回头查的一张。
        or (
          snapshot.source_type = 'contract_item'
          and snapshot.source_id = case p_subject_type
            when 'subscription' then (
              select contract_item_id from ops.subscriptions where id = p_subject_id
            )
            else (
              select contract_item_id from ops.private_licenses where id = p_subject_id
            )
          end
        )
        or (
          snapshot.source_type = 'change_request'
          and snapshot.source_id in (
            select request.id
            from ops.entitlement_change_requests as request
            where request.subject_type = p_subject_type
              and request.subject_id = p_subject_id
          )
        )
      )
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.valid_from desc nulls last, filtered.created_at desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.snapshot_summary_json(page.id) order by
          filtered.valid_from desc nulls last, filtered.created_at desc, filtered.id
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


CREATE OR REPLACE FUNCTION ops.get_entitlement_snapshot (p_snapshot_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  summary jsonb;
begin
  perform ops.require_permission('entitlement.read');

  summary := ops.snapshot_summary_json(p_snapshot_id);
  if summary is null then
    return jsonb_build_object('status', 'snapshot_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'snapshot', summary,
    'lines', ops.snapshot_lines_json(p_snapshot_id)
  );
end;
$$;


-- ── 18. 读：变更申请 ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_entitlement_change_requests (
  p_subject_type text DEFAULT NULL,
  p_statuses TEXT[] DEFAULT NULL,
  p_customer_id uuid DEFAULT NULL,
  p_requested_by uuid DEFAULT NULL,
  p_limit integer DEFAULT NULL,
  p_offset integer DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  result jsonb;
begin
  perform ops.require_permission('entitlement.read');

  -- 变更单没有 customer_id 列（它属于主体，不属于单据）。按客户筛只能回查
  -- 主体，两条左连接各按 subject_type 命中一条。
  with filtered as (
    select request.*, coalesce(subscription.customer_id, license.customer_id) as customer_id
    from ops.entitlement_change_requests as request
    left join ops.subscriptions as subscription
      on request.subject_type = 'subscription' and subscription.id = request.subject_id
    left join ops.private_licenses as license
      on request.subject_type = 'license' and license.id = request.subject_id
    where (p_subject_type is null or request.subject_type = p_subject_type)
      and (
        p_statuses is null
        or cardinality(p_statuses) = 0
        or request.status = any (p_statuses)
      )
      and (p_customer_id is null or coalesce(subscription.customer_id, license.customer_id) = p_customer_id)
      and (p_requested_by is null or request.requested_by = p_requested_by)
  ),
  page as (
    select filtered.id
    from filtered
    order by filtered.created_at desc, filtered.id
    limit greatest(coalesce(p_limit, 20), 1)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select jsonb_build_object(
    'status', 'ok',
    'total', (select count(*) from filtered),
    'items', coalesce(
      (
        select jsonb_agg(ops.change_request_json(page.id) order by filtered.created_at desc, filtered.id)
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


CREATE OR REPLACE FUNCTION ops.get_entitlement_change_request (p_change_request_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  detail jsonb;
begin
  perform ops.require_permission('entitlement.read');

  detail := ops.change_request_json(p_change_request_id);
  if detail is null then
    return jsonb_build_object('status', 'change_request_not_found');
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'change_request', detail,
    'diff', ops.change_request_diff(p_change_request_id),
    -- 契约 §5.6 的 `command?`。命令表属 o-t10（见设计要点 7）。
    'command', null
  );
end;
$$;


-- ── 19. 授权 ───────────────────────────────────────────────────────────────
REVOKE ALL ON TABLE ops.subscriptions,
ops.private_licenses,
ops.entitlement_snapshots,
ops.entitlement_snapshot_lines,
ops.entitlement_change_requests
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.subscriptions ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.private_licenses ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.entitlement_snapshots ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.entitlement_snapshot_lines ENABLE ROW LEVEL SECURITY;


ALTER TABLE ops.entitlement_change_requests ENABLE ROW LEVEL SECURITY;


REVOKE ALL ON SEQUENCE ops.subscription_no_seq,
ops.license_no_seq
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allowed_subject_actions (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.allowed_change_request_actions (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.entitlement_contract_status_allows (text, date)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.feature_lines_base (uuid, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.feature_lines_apply (jsonb, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.feature_lines_sorted (jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.snapshot_content_hash (jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.snapshot_lines_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.snapshot_summary_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.snapshot_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.subject_json (text, uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.change_request_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.change_request_diff (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_snapshot (uuid, text, uuid, text, uuid, date, date, jsonb)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.apply_change_request_snapshot (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_subscription (
  uuid,
  uuid,
  text,
  date,
  date,
  boolean,
  jsonb,
  text
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_license (
  uuid,
  uuid,
  uuid,
  text,
  date,
  date,
  date,
  jsonb,
  text
)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.transition_entitlement_subject (text, uuid, text, text, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.create_entitlement_change_request (text, uuid, text, text, jsonb, date)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.transition_entitlement_change_request (uuid, text, text, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_subscriptions (uuid, TEXT[], uuid, integer, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_subscription (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_licenses (uuid, TEXT[], integer, uuid, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_license (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_entitlement_snapshots (text, uuid, date, date, text, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_entitlement_snapshot (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_entitlement_change_requests (text, TEXT[], uuid, uuid, integer, integer)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.get_entitlement_change_request (uuid)
FROM
  public,
  anon,
  authenticated;


GRANT
EXECUTE ON function ops.list_subscriptions (uuid, TEXT[], uuid, integer, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_subscription (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_subscription (
  uuid,
  uuid,
  text,
  date,
  date,
  boolean,
  jsonb,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_entitlement_subject (text, uuid, text, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_licenses (uuid, TEXT[], integer, uuid, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_license (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_license (
  uuid,
  uuid,
  uuid,
  text,
  date,
  date,
  date,
  jsonb,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_entitlement_change_request (text, uuid, text, text, jsonb, date) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_entitlement_change_request (uuid, text, text, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_entitlement_snapshots (text, uuid, date, date, text, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_entitlement_snapshot (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_entitlement_change_requests (text, TEXT[], uuid, uuid, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_entitlement_change_request (uuid) TO authenticated,
service_role;


COMMENT ON TABLE ops.subscriptions IS 'SaaS 订阅（契约 §3.5）。current_snapshot_id 指向当前生效的权益快照；一个合同条目同时只能有一条非终态订阅。';


COMMENT ON TABLE ops.private_licenses IS '私有化授权（契约 §3.5）。永久授权无 valid_to；维护期与授权期独立，不互相推导。';


COMMENT ON TABLE ops.entitlement_snapshots IS '权益快照，仅 INSERT（触发器兜底）。content_hash 只覆盖语义四字段，展示名不进哈希。';


COMMENT ON TABLE ops.entitlement_snapshot_lines IS '快照明细，仅 INSERT。display_name_snapshot 冻结发放当时的字典名称。';


COMMENT ON TABLE ops.entitlement_change_requests IS '权益变更申请（契约 §3.5）。申请人≠审批人由 CHECK 兜底；command_id 属 o-t10 软引用。';


COMMENT ON function ops.allowed_subject_actions (text) IS '订阅/授权状态机的合法动作（契约 §3.5）。订阅与授权共用一套。';


COMMENT ON function ops.feature_lines_apply (jsonb, jsonb) IS '在基线上套用增量。基线由调用方给：新建订阅传套餐权益，变更申请传当前快照的行。';


COMMENT ON function ops.snapshot_content_hash (jsonb) IS '只哈希 feature_key / enabled / quota_value / term_months 四字段，展示名与顺序不计入。';


COMMENT ON function ops.create_snapshot (uuid, text, uuid, text, uuid, date, date, jsonb) IS '发放快照。同一来源同一内容命中既有快照时返回它，不新建、不报错。';


COMMENT ON function ops.transition_entitlement_subject (text, uuid, text, text, integer) IS '订阅/授权状态迁移。权限按动作判；未审批即下发回 approval_required 而非 invalid_transition。';


COMMENT ON function ops.apply_change_request_snapshot (uuid) IS '执行变更单：换 current_snapshot_id，且只在 suspend/resume/expire/revoke 四种类型上改主体状态。';