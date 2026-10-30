-- 运营身份基座：6 张表 + 4 个函数 + 39 个动作码与 6 个角色的 seed（契约 §3.9、§4）。
--
-- 设计要点：
--
-- 1. 身份与权限只来自这三张表（operators / operator_roles / role_permissions），
--    不读 user_metadata 或 app_metadata —— 那两个字段可被用户自助修改或由第三方
--    写入，拿它判权限等于把授权交给被授权者。
--
-- 2. 所有判定函数都是 SECURITY DEFINER + search_path = ''。前者不是为了提权，而是
--    为了打断递归：`ops.operators` 的 SELECT 策略调 `current_operator_id()`，而该
--    函数要查 `ops.operators`；若以调用者权限执行，策略会再次触发策略，Postgres 会
--    直接报 infinite recursion。后者让函数体里的未限定名无法被劫持 —— 空 search_path
--    下所有引用必须写全 schema，注入者没有可插队的解析路径。
--
-- 3. 写权限一行都不授予 authenticated。operators / roles / role_permissions /
--    operator_roles 属于契约 §7.3 的 A2 类（状态机与聚合，只能经 SECURITY DEFINER
--    RPC 改），audit_events 属于 B 类（追加不可变）。授予写权限等于把「最后一个
--    管理员不能被移除」「角色变更必须写审计」这些规则交给调用方自觉。
--
-- 4. `permission_version` 是契约 §5.1 `/session` 要求的 `permissionVersion` 的落地。
--    任何一次角色或权限变更必须在同一事务里 +1，不用 `max(updated_at)`：时间戳会被
--    时钟回拨与同秒更新搞坏，一个单调计数器不会。
--
-- 5. schema 的 USAGE 这次补授给 authenticated（契约 §7.2）。上一个迁移只授了
--    service_role，那是按「客户端一律不碰 ops」写的；契约的实际模型是「Worker 用
--    用户令牌访问，RLS 才真正生效」，service_role 在请求路径上被明令禁止。两者
--    差别不在宽松程度而在**哪一层负责拒绝**：不给 USAGE 是让 Postgres 在入口处
--    报 42501，给了 USAGE 则由每张表的策略逐行判定。契约选后者，因为前者只能
--    表达「不许进 ops」，表达不了「运营成员只能看自己该看的行」。anon 仍然没有
--    USAGE，P1 拒绝路径不变。
--
-- 6. 这里的 seed 是「初始映射」，不是后端分支。函数只判断动作码，不判断角色名
--    （契约 §4 首条规则）：平台管理员拿满 39 个码，不是靠 `if role = 'platform_admin'`
--    绕过检查。
CREATE TABLE ops.operators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 指向 auth.users，不是 operator 主键。审计表另有一列 actor_operator_id，
  -- 两个键分开存，同一个词就不能指两个东西。
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  email text NOT NULL CHECK (length(btrim(email)) > 0),
  display_name text,
  status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited', 'active', 'disabled')),
  mfa_required boolean NOT NULL DEFAULT FALSE,
  -- 单调递增，与 updated_at 无关。角色/权限变更时同事务 +1。
  permission_version bigint NOT NULL DEFAULT 1 CHECK (permission_version > 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  invited_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  last_login_at timestamptz,
  disabled_at timestamptz,
  disabled_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT operators_user_id_key UNIQUE (user_id)
);


-- 邮箱大小写不敏感唯一：邀请时写进来的大小写与登录时 GoTrue 返回的未必一致，
-- 按原值做唯一约束会放过「Alice@x.com」与「alice@x.com」两个账号。
CREATE UNIQUE INDEX operators_email_lower_idx ON ops.operators (lower(email));


CREATE INDEX operators_status_idx ON ops.operators (status);


CREATE TABLE ops.roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL CHECK (length(btrim(code)) > 0),
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  description text,
  is_system boolean NOT NULL DEFAULT FALSE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT roles_code_key UNIQUE (code)
);


CREATE TABLE ops.permissions (
  code text PRIMARY KEY,
  domain text NOT NULL,
  description text NOT NULL,
  is_high_risk boolean NOT NULL DEFAULT FALSE
);


CREATE INDEX permissions_domain_idx ON ops.permissions (domain);


CREATE TABLE ops.role_permissions (
  role_id uuid NOT NULL REFERENCES ops.roles (id) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES ops.permissions (code) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_code)
);


CREATE TABLE ops.operator_roles (
  operator_id uuid NOT NULL REFERENCES ops.operators (id) ON DELETE CASCADE,
  -- 角色被删除前必须先解绑：RESTRICT 让「删角色顺带清空持有者的权限」这件事
  -- 在数据库层就无法发生。
  role_id uuid NOT NULL REFERENCES ops.roles (id) ON DELETE RESTRICT,
  granted_by uuid NOT NULL REFERENCES ops.operators (id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, role_id)
);


CREATE INDEX operator_roles_role_idx ON ops.operator_roles (role_id);


CREATE TABLE ops.audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_operator_id uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  action text NOT NULL CHECK (length(btrim(action)) > 0),
  entity_type text NOT NULL CHECK (length(btrim(entity_type)) > 0),
  entity_id uuid,
  request_id text,
  reason text,
  before_summary jsonb,
  after_summary jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX audit_events_created_idx ON ops.audit_events (created_at DESC);


CREATE INDEX audit_events_entity_idx ON ops.audit_events (entity_type, entity_id);


CREATE INDEX audit_events_actor_idx ON ops.audit_events (actor_operator_id, created_at DESC);


CREATE INDEX audit_events_action_idx ON ops.audit_events (action);


-- ── 判定函数 ────────────────────────────────────────────────────────────────
-- 当前运营账号主键；非运营成员、非 active 一律 null。
-- 返回值不是「有没有登录」，而是「是不是一个当前有效的运营成员」——所有策略
-- 都以它为前提，所以禁用账号的旧 token 会立刻失效（token 本身还没过期）。
CREATE OR REPLACE FUNCTION ops.current_operator_id () returns uuid language sql stable security definer
SET
  search_path = '' AS $$
  select operator.id
  from ops.operators as operator
  where operator.user_id = (select auth.uid())
    and operator.status = 'active'
  limit 1;
$$;


-- 动作码并集。多角色取并集，停用的角色与停用的账号都不贡献权限。
CREATE OR REPLACE FUNCTION ops.has_permission (requested_permission text) returns boolean language sql stable security definer
SET
  search_path = '' AS $$
  select exists (
    select 1
    from ops.operators as operator
    join ops.operator_roles as operator_role
      on operator_role.operator_id = operator.id
    join ops.roles as role
      on role.id = operator_role.role_id
    join ops.role_permissions as role_permission
      on role_permission.role_id = role.id
    where operator.user_id = (select auth.uid())
      and operator.status = 'active'
      and role.status = 'active'
      and role_permission.permission_code = requested_permission
  );
$$;


-- `/session` 的唯一数据来源。一次往返拿全，避免「先查账号再查角色再查权限」
-- 三次往返之间账号被禁用而产生的自相矛盾快照。
CREATE OR REPLACE FUNCTION ops.get_current_ops_context () returns TABLE (
  operator_id uuid,
  operator_email text,
  operator_display_name text,
  operator_status text,
  mfa_required boolean,
  permission_version bigint,
  last_login_at timestamptz,
  role_codes TEXT[],
  role_names TEXT[],
  permission_codes TEXT[]
) language sql stable security definer
SET
  search_path = '' AS $$
  select
    operator.id,
    operator.email,
    operator.display_name,
    operator.status,
    operator.mfa_required,
    operator.permission_version,
    operator.last_login_at,
    (
      select coalesce(array_agg(role.code order by role.code), array[]::text[])
      from ops.operator_roles as operator_role
      join ops.roles as role on role.id = operator_role.role_id
      where operator_role.operator_id = operator.id
        and role.status = 'active'
    ),
    (
      select coalesce(array_agg(role.name order by role.code), array[]::text[])
      from ops.operator_roles as operator_role
      join ops.roles as role on role.id = operator_role.role_id
      where operator_role.operator_id = operator.id
        and role.status = 'active'
    ),
    (
      select coalesce(array_agg(distinct role_permission.permission_code), array[]::text[])
      from ops.operator_roles as operator_role
      join ops.roles as role on role.id = operator_role.role_id and role.status = 'active'
      join ops.role_permissions as role_permission on role_permission.role_id = role.id
      where operator_role.operator_id = operator.id
    )
  from ops.operators as operator
  where operator.user_id = (select auth.uid())
    and operator.status = 'active';
$$;


-- RPC 内的第一道门：没有运营上下文或无该项动作码一律 42501。
--
-- 为什么统一 42501 而不是 403 业务错误：这是数据库层，能走到这里说明调用者绕过
-- 了 Worker 的 requireOpsAuth；把它伪装成业务错误会让「越权」看起来像「参数不对」。
CREATE OR REPLACE FUNCTION ops.require_permission (requested_permission text) returns void language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  if (select ops.current_operator_id()) is null then
    raise exception 'ops operator context missing' using errcode = '42501';
  end if;
  if not (select ops.has_permission(requested_permission)) then
    raise exception 'ops permission denied: %', requested_permission using errcode = '42501';
  end if;
end;
$$;


-- 审计写入。actor 两列一律从会话推导，不接受调用方传入 —— 可传入的 actor 等于
-- 可伪造的 actor，而审计的全部价值就在于它不可伪造。
--
-- service_role 调用时 auth.uid() 为空，两列都记 null；这类写入只应出现在
-- 定时清理等无人的场景，任何有人参与的路径都必须带用户令牌。
CREATE OR REPLACE FUNCTION ops.write_audit (
  audit_action text,
  audit_entity_type text,
  audit_entity_id uuid DEFAULT NULL,
  audit_reason text DEFAULT NULL,
  audit_before jsonb DEFAULT NULL,
  audit_after jsonb DEFAULT NULL,
  audit_request_id text DEFAULT NULL
) returns uuid language plpgsql security definer
SET
  search_path = '' AS $$
declare
  new_event_id uuid := gen_random_uuid();
begin
  insert into ops.audit_events (
    id, actor_operator_id, actor_user_id, action, entity_type, entity_id,
    request_id, reason, before_summary, after_summary
  )
  values (
    new_event_id,
    (select ops.current_operator_id()),
    (select auth.uid()),
    audit_action,
    audit_entity_type,
    audit_entity_id,
    audit_request_id,
    audit_reason,
    audit_before,
    audit_after
  );
  return new_event_id;
end;
$$;


-- ── 授权 ────────────────────────────────────────────────────────────────────
-- 契约 §7.2：anon 无 USAGE（P1），authenticated 有 USAGE 但每张表靠策略判行。
GRANT usage ON schema ops TO authenticated;


REVOKE ALL ON function ops.current_operator_id ()
FROM
  public,
  anon;


REVOKE ALL ON function ops.has_permission (text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.get_current_ops_context ()
FROM
  public,
  anon;


REVOKE ALL ON function ops.require_permission (text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.write_audit (text, text, uuid, text, jsonb, jsonb, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.current_operator_id () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.has_permission (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_current_ops_context () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.require_permission (text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.write_audit (text, text, uuid, text, jsonb, jsonb, text) TO authenticated,
service_role;


-- 只读六张表。写权限一行都不给：A2/B 类的写入只经 SECURITY DEFINER RPC。
GRANT
SELECT
  ON ops.operators,
  ops.roles,
  ops.permissions,
  ops.role_permissions,
  ops.operator_roles,
  ops.audit_events TO authenticated;


ALTER TABLE ops.operators enable ROW level security;


ALTER TABLE ops.roles enable ROW level security;


ALTER TABLE ops.permissions enable ROW level security;


ALTER TABLE ops.role_permissions enable ROW level security;


ALTER TABLE ops.operator_roles enable ROW level security;


ALTER TABLE ops.audit_events enable ROW level security;


-- 策略一律「先判是不是有效运营成员，再判动作码」。只判前者的策略等于
-- 「登录了就能看全部」，正是契约 §7.3 明令禁止的写法。
CREATE POLICY operators_select_operator_reader ON ops.operators FOR
SELECT
  TO authenticated USING (
    (
      SELECT
        ops.current_operator_id ()
    ) IS NOT NULL
    AND (
      SELECT
        ops.has_permission ('operator.read')
    )
  );


CREATE POLICY roles_select_operator_reader ON ops.roles FOR
SELECT
  TO authenticated USING (
    (
      SELECT
        ops.current_operator_id ()
    ) IS NOT NULL
    AND (
      SELECT
        ops.has_permission ('operator.read')
    )
  );


CREATE POLICY permissions_select_operator_reader ON ops.permissions FOR
SELECT
  TO authenticated USING (
    (
      SELECT
        ops.current_operator_id ()
    ) IS NOT NULL
    AND (
      (
        SELECT
          ops.has_permission ('operator.read')
      )
      OR (
        SELECT
          ops.has_permission ('role.manage')
      )
    )
  );


CREATE POLICY role_permissions_select_operator_reader ON ops.role_permissions FOR
SELECT
  TO authenticated USING (
    (
      SELECT
        ops.current_operator_id ()
    ) IS NOT NULL
    AND (
      (
        SELECT
          ops.has_permission ('operator.read')
      )
      OR (
        SELECT
          ops.has_permission ('role.manage')
      )
    )
  );


CREATE POLICY operator_roles_select_operator_reader ON ops.operator_roles FOR
SELECT
  TO authenticated USING (
    (
      SELECT
        ops.current_operator_id ()
    ) IS NOT NULL
    AND (
      SELECT
        ops.has_permission ('operator.read')
    )
  );


CREATE POLICY audit_events_select_audit_reader ON ops.audit_events FOR
SELECT
  TO authenticated USING (
    (
      SELECT
        ops.current_operator_id ()
    ) IS NOT NULL
    AND (
      SELECT
        ops.has_permission ('audit.read')
    )
  );


-- ── seed：39 个动作码（契约 §4 逐条） ───────────────────────────────────────
INSERT INTO
  ops.permissions (code, domain, description, is_high_risk)
VALUES
  (
    'overview.read',
    'identity-audit',
    '查看运营总览与下钻指标',
    FALSE
  ),
  (
    'customer.read',
    'customer',
    '查看客户、联系人（联系方式掩码）',
    FALSE
  ),
  (
    'customer.write',
    'customer',
    '新建/编辑/停用客户与联系人',
    FALSE
  ),
  (
    'customer.sensitive.read',
    'customer',
    '查看联系人电话/邮箱原值',
    FALSE
  ),
  (
    'catalog.read',
    'catalog',
    '查看产品、套餐、价格版本、功能键',
    FALSE
  ),
  (
    'catalog.write',
    'catalog',
    '维护产品/套餐/价格版本/功能键/套餐权益',
    FALSE
  ),
  (
    'contract.read',
    'contract',
    '查看合同、条目、版本、附件列表',
    FALSE
  ),
  (
    'contract.write',
    'contract',
    '草拟/编辑/提交/续约发起/变更单提交',
    FALSE
  ),
  (
    'contract.approve',
    'contract',
    '签署确认、生效、终止、变更单批准',
    TRUE
  ),
  (
    'receivable.read',
    'billing',
    '查看应收计划、收款、核销、退款、导出账款明细',
    FALSE
  ),
  (
    'receivable.write',
    'billing',
    '生成/调整应收计划、展期',
    FALSE
  ),
  ('receipt.record', 'billing', '登记线下收款', FALSE),
  (
    'receipt.approve',
    'billing',
    '审核/驳回收款登记（审核后计入实收）',
    TRUE
  ),
  ('receipt.reconcile', 'billing', '核销收款到应收', TRUE),
  ('receipt.reverse', 'billing', '撤销核销、收款冲正', TRUE),
  ('receipt.refund', 'billing', '登记退款', TRUE),
  (
    'entitlement.read',
    'entitlement',
    '查看订阅、授权、权益快照、变更历史',
    FALSE
  ),
  (
    'entitlement.request',
    'entitlement',
    '创建订阅/授权草案、提交权益变更申请',
    FALSE
  ),
  (
    'entitlement.approve',
    'entitlement',
    '审核权益变更申请',
    TRUE
  ),
  (
    'entitlement.execute',
    'entitlement',
    '执行已批准的权益变更并下发同步命令',
    TRUE
  ),
  (
    'tenant.read',
    'tenant-integration',
    '查看租户映射、命令状态、尝试记录',
    FALSE
  ),
  (
    'tenant.provision',
    'tenant-integration',
    '创建/绑定租户映射并发起开通',
    TRUE
  ),
  (
    'tenant.suspend',
    'tenant-integration',
    '暂停租户',
    TRUE
  ),
  (
    'tenant.restore',
    'tenant-integration',
    '恢复租户',
    TRUE
  ),
  (
    'tenant.retry',
    'tenant-integration',
    '重试失败命令',
    TRUE
  ),
  (
    'deployment.read',
    'deployment',
    '查看部署实例与升级历史',
    FALSE
  ),
  (
    'deployment.write',
    'deployment',
    '维护实例、登记升级结果、变更环境状态',
    FALSE
  ),
  ('ticket.read', 'support', '查看工单与时间线', FALSE),
  ('ticket.create', 'support', '创建工单', FALSE),
  ('ticket.assign', 'support', '分派/改派工单', FALSE),
  (
    'ticket.update',
    'support',
    '处理说明、等待、解决、编辑工单字段',
    FALSE
  ),
  ('ticket.close', 'support', '关闭工单、重开工单', FALSE),
  (
    'operator.read',
    'identity-audit',
    '查看运营账号与角色',
    FALSE
  ),
  (
    'operator.manage',
    'identity-audit',
    '邀请/禁用账号、分配角色',
    TRUE
  ),
  (
    'role.manage',
    'identity-audit',
    '创建角色、编辑角色权限',
    TRUE
  ),
  (
    'settings.manage',
    'identity-audit',
    '系统设置、字典维护',
    FALSE
  ),
  ('audit.read', 'identity-audit', '查询审计事件', FALSE),
  (
    'export.read',
    'identity-audit',
    '查看导出任务与下载结果',
    FALSE
  ),
  ('export.create', 'identity-audit', '发起数据导出', TRUE);


-- ── seed：6 个预置角色（契约 §4 预置角色 → 权限映射） ────────────────────────
INSERT INTO
  ops.roles (code, name, description, is_system)
VALUES
  (
    'platform_admin',
    '平台管理员',
    '拥有全部动作码；敏感动作仍需对应动作码，不做超级用户绕过',
    TRUE
  ),
  ('sales_ops', '商务运营', '客户、目录、合同与权益申请', TRUE),
  ('finance_ops', '财务运营', '应收、收款、核销、退款与审计查询', TRUE),
  ('delivery_ops', '交付运营', '客户、权益执行、租户与部署', TRUE),
  (
    'support_agent',
    '售后支持',
    '只读客户合同，可处理工单；不读收款敏感信息',
    TRUE
  ),
  ('ops_viewer', '运营只读', '全业务域只读', TRUE);


-- 平台管理员拿满：动作码驱动，不是角色名特判。
INSERT INTO
  ops.role_permissions (role_id, permission_code)
SELECT
  role.id,
  permission.code
FROM
  ops.roles AS role
  CROSS JOIN ops.permissions AS permission
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.role_permissions (role_id, permission_code)
SELECT
  role.id,
  granted.code
FROM
  ops.roles AS role
  JOIN (
    VALUES
      ('customer.read'),
      ('customer.write'),
      ('customer.sensitive.read'),
      ('catalog.read'),
      ('contract.read'),
      ('contract.write'),
      ('receivable.read'),
      ('entitlement.read'),
      ('entitlement.request'),
      ('tenant.read'),
      ('deployment.read'),
      ('ticket.read'),
      ('ticket.create'),
      ('ticket.update'),
      ('overview.read'),
      ('export.create')
  ) AS granted (code) ON TRUE
WHERE
  role.code = 'sales_ops';


INSERT INTO
  ops.role_permissions (role_id, permission_code)
SELECT
  role.id,
  granted.code
FROM
  ops.roles AS role
  JOIN (
    VALUES
      ('customer.read'),
      ('contract.read'),
      ('receivable.read'),
      ('receivable.write'),
      ('receipt.record'),
      ('receipt.approve'),
      ('receipt.reconcile'),
      ('receipt.refund'),
      ('receipt.reverse'),
      ('entitlement.read'),
      ('audit.read'),
      ('overview.read'),
      ('export.create')
  ) AS granted (code) ON TRUE
WHERE
  role.code = 'finance_ops';


INSERT INTO
  ops.role_permissions (role_id, permission_code)
SELECT
  role.id,
  granted.code
FROM
  ops.roles AS role
  JOIN (
    VALUES
      ('customer.read'),
      ('customer.write'),
      ('catalog.read'),
      ('contract.read'),
      ('entitlement.read'),
      ('entitlement.request'),
      ('entitlement.execute'),
      ('tenant.read'),
      ('tenant.provision'),
      ('tenant.suspend'),
      ('tenant.restore'),
      ('tenant.retry'),
      ('deployment.read'),
      ('deployment.write'),
      ('ticket.read'),
      ('ticket.update'),
      ('overview.read')
  ) AS granted (code) ON TRUE
WHERE
  role.code = 'delivery_ops';


-- 售后支持刻意不含 customer.sensitive.read 与任何 receivable.*：PRD §4.2 要求
-- 「不得读取不必要的完整收款敏感信息」，这条映射就是它的落地形态。
INSERT INTO
  ops.role_permissions (role_id, permission_code)
SELECT
  role.id,
  granted.code
FROM
  ops.roles AS role
  JOIN (
    VALUES
      ('customer.read'),
      ('contract.read'),
      ('entitlement.read'),
      ('tenant.read'),
      ('deployment.read'),
      ('ticket.read'),
      ('ticket.create'),
      ('ticket.assign'),
      ('ticket.update'),
      ('ticket.close'),
      ('overview.read')
  ) AS granted (code) ON TRUE
WHERE
  role.code = 'support_agent';


INSERT INTO
  ops.role_permissions (role_id, permission_code)
SELECT
  role.id,
  granted.code
FROM
  ops.roles AS role
  JOIN (
    VALUES
      ('customer.read'),
      ('catalog.read'),
      ('contract.read'),
      ('receivable.read'),
      ('entitlement.read'),
      ('tenant.read'),
      ('deployment.read'),
      ('ticket.read'),
      ('overview.read'),
      ('audit.read')
  ) AS granted (code) ON TRUE
WHERE
  role.code = 'ops_viewer';


COMMENT ON TABLE ops.operators IS '运营账号。身份来自 auth.users，权限来自 operator_roles → role_permissions，不读 metadata。';


COMMENT ON TABLE ops.permissions IS '动作码目录（39 条，契约 §4）。只读，由迁移 seed；与 packages/contracts 常量双向对账。';


COMMENT ON COLUMN ops.operators.permission_version IS '单调递增的权限版本。/session 的 permissionVersion 取自此处，角色变更同事务 +1。';


COMMENT ON COLUMN ops.audit_events.actor_user_id IS 'auth 用户 id（= ops.operators.user_id），不是 operator 主键；operator 主键见 actor_operator_id。';