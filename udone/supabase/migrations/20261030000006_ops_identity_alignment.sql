-- 身份域口径补齐（D-01 / D-02 / D-05）。
--
-- 本迁移只补三件此前没有入口的事，不新增状态、不新增审计动作：
--
-- 1. 邀请之后的第一次登录把 `invited` 转成 `active`（D-01）。此前 `ops.operators`
--    没有任何路径写这个转换，于是「已邀请」事实上是终态：管理员必须回列表手工
--    PATCH 一次，对方才能进。代价（邀请即开通）已在决策里认过。
--
-- 2. `display_name` 的写入口（D-02）。列存在、列表会返回、审计能读，但邀请与
--    PATCH 都不收这个字段——新账号的显示名永远为空。
--
-- 3. 登录成功时写 `last_login_at`（D-05）。同一列被 `/session` 与账号列表排序
--    使用，而此前全库没有一处写它，所以永远显示空。
--
-- 两个新函数沿用 `ops.login_member_state()` 的形状：无参、SECURITY DEFINER、
-- `SET search_path = ''`、身份取 `auth.uid()`。参数化会让人拿别人的 uid 去激活
-- 或改时间；这两个动作都不需要调用方自述身份。
--
-- **不写审计**：D-03 只认五个动作词，`operator.updated` 才是「账号被改动」的那
-- 一个。为一次自助激活另造 `operator.activated` 会得到一个没人筛、也没人认的词，
-- 而审计词表的全部价值在于「筛选下拉里就是全集」。
CREATE OR REPLACE FUNCTION ops.activate_invited_member () returns text language plpgsql security definer
SET
  search_path = '' AS $$
declare
  changed integer;
begin
  -- 只动 `invited` 这一行：`disabled` 不复活（停用是管理员做的决定，不该被一次
  -- 登录覆盖），`active` 也不再自增 version（并发重试不该让乐观锁值漂移）。
  update ops.operators as operator
  set
    status = 'active',
    updated_at = now(),
    version = operator.version + 1
  where operator.user_id = (select auth.uid())
    and operator.status = 'invited';

  get diagnostics changed = row_count;

  if changed > 0 then
    return 'activated';
  end if;

  -- 有行但没被改：状态不是 invited（已 active / 已 disabled）。
  if exists (
    select 1
    from ops.operators as operator
    where operator.user_id = (select auth.uid())
  ) then
    return 'unchanged';
  end if;

  -- 连行都没有：租户成员、service_role（auth.uid() 为空）、或行已被删。
  return 'missing';
end;
$$;


-- 登录成功的那一次写。与激活分开，因为失败策略不同：激活失败登录不成立
-- （否则发出去的令牌会被 `status = 'active'` 挡回 403，用户看到「登录成功但进不去」），
-- 而这个字段只是展示用，写失败不该让登录失败。
CREATE OR REPLACE FUNCTION ops.touch_last_login () returns text language plpgsql security definer
SET
  search_path = '' AS $$
declare
  changed integer;
begin
  -- 不带 version：登录不是一次「账号变更」，让它自增会把管理员手里刚从列表拿到的
  -- 乐观锁值作废，而那是一次 409「有人先改了」——其实没人改。
  update ops.operators as operator
  set
    last_login_at = now()
  where operator.user_id = (select auth.uid())
    and operator.status = 'active';

  get diagnostics changed = row_count;

  if changed > 0 then
    return 'ok';
  end if;

  return 'missing';
end;
$$;


REVOKE ALL ON function ops.activate_invited_member ()
FROM
  public,
  anon;


REVOKE ALL ON function ops.touch_last_login ()
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.activate_invited_member () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.touch_last_login () TO authenticated,
service_role;


COMMENT ON function ops.activate_invited_member () IS '登录端点专用（D-01）：把 auth.uid() 对应的 invited 账号转成 active。无参数，只返回 activated / unchanged / missing。';


COMMENT ON function ops.touch_last_login () IS '登录端点专用（D-05）：仅对 active 行写 last_login_at。无参数，只返回 ok / missing。';


-- ── ops.invite_operator：补 p_display_name ──────────────────────────────────
-- 先 DROP 再建：`CREATE OR REPLACE` 遇到参数表不同会造出**重载**，两个签名同时
-- 存在，PostgREST 按请求体的键挑函数——少传一个键时挑到哪个取决于缓存，表现为
-- 「同一份请求有时 404」。DROP 之后旧授权一并消失，所以下面重新授一次。
DROP FUNCTION ops.invite_operator (uuid, text, TEXT[], text, text);


CREATE OR REPLACE FUNCTION ops.invite_operator (
  p_user_id uuid,
  p_email text,
  p_role_codes TEXT[],
  p_reason text,
  p_request_id text DEFAULT NULL,
  p_display_name text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid;
  unknown_codes text[];
  normalized_email text := lower(btrim(coalesce(p_email, '')));
  normalized_display_name text := nullif(btrim(coalesce(p_display_name, '')), '');
begin
  perform ops.require_permission('operator.manage');

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'reason_required');
  end if;

  -- 邀请不带角色等于建了一个登录后什么都做不了的账号。PRD §4.3「至少一个运营角色」
  -- 在这里是硬约束，而不是前端的一次性提示。
  if p_role_codes is null or cardinality(p_role_codes) = 0 then
    return jsonb_build_object('status', 'roles_required');
  end if;

  unknown_codes := ops.unknown_role_codes(p_role_codes);
  if cardinality(unknown_codes) > 0 then
    return jsonb_build_object('status', 'unknown_role', 'codes', to_jsonb(unknown_codes));
  end if;

  if exists (
    select 1
    from ops.operators as operator
    where lower(operator.email) = normalized_email
      or operator.user_id = p_user_id
  ) then
    return jsonb_build_object('status', 'email_exists');
  end if;

  -- 显示名是可选字段：`''` 与纯空白都落 NULL，而不是存一个长度为 0 的字符串——
  -- 列表按 `display_name` 排序时，空串会排在一个确定的位置，NULL 才排最后。
  insert into ops.operators (user_id, email, display_name, status, invited_by)
  values (p_user_id, normalized_email, normalized_display_name, 'invited', actor_id)
  returning id into new_id;

  insert into ops.operator_roles (operator_id, role_id, granted_by)
  select new_id, role.id, actor_id
  from ops.roles as role
  where role.code = any (p_role_codes)
    and role.status = 'active';

  perform ops.write_audit(
    'operator.invited',
    'operator',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'email', normalized_email,
      'displayName', normalized_display_name,
      'roleCodes', to_jsonb(p_role_codes)
    ),
    p_request_id
  );

  -- 邀请链接的有效期由 GoTrue 的邮件配置决定（`MAILER_OTP_EXP`，默认 24h）。
  -- 这里按 24h 返回：与默认值对齐，但**未经真机确认**——换过配置的项目返回值会偏。
  return jsonb_build_object(
    'status', 'ok',
    'operator', ops.operator_json(new_id),
    'invitation_expires_at', now() + interval '24 hours'
  );
end;
$$;


REVOKE ALL ON function ops.invite_operator (uuid, text, TEXT[], text, text, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.invite_operator (uuid, text, TEXT[], text, text, text) TO authenticated,
service_role;


COMMENT ON function ops.invite_operator (uuid, text, TEXT[], text, text, text) IS '邀请写侧。p_display_name 可选，空串/空白落 NULL（D-02）。';


-- ── ops.update_operator：补 p_display_name ──────────────────────────────────
-- 语义与邀请不同，且必须不同：这里的 `NULL` 已经是「不改」的哨兵（`p_status`、
-- `p_role_codes`、`p_mfa_required` 都是这个约定），所以「清空显示名」不能也用
-- NULL 表达——那会让「不传」与「清空」变成同一件事，而前者是绝大多数调用。
-- 约定：NULL = 不改；`''` 或纯空白 = 置 NULL（清空）。
DROP FUNCTION ops.update_operator (uuid, integer, text, TEXT[], boolean, text, text);


CREATE OR REPLACE FUNCTION ops.update_operator (
  p_operator_id uuid,
  p_expected_version integer,
  p_status text DEFAULT NULL,
  p_role_codes TEXT[] DEFAULT NULL,
  p_mfa_required boolean DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_display_name text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.operators;
  before_codes text[];
  after_codes text[];
  before_permissions text[];
  after_permissions text[];
  added_permissions text[];
  removed_permissions text[];
  unknown_codes text[];
  effective_status text;
  effective_display_name text;
  others_with_manage integer;
  admins_before integer;
  admins_after integer;
begin
  perform ops.require_permission('operator.manage');

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'reason_required');
  end if;

  -- FOR UPDATE：两个管理员同时改同一个账号时，后到者的版本比较必须在锁内做。
  -- 不锁的话两边都读到 version=3，两边都写成功，版本号停在 4。
  select * into target
  from ops.operators as operator
  where operator.id = p_operator_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if target.version <> p_expected_version then
    return jsonb_build_object('status', 'version_mismatch', 'current_version', target.version);
  end if;

  select coalesce(array_agg(distinct role.code order by role.code), array[]::text[])
  into before_codes
  from ops.operator_roles as operator_role
  join ops.roles as role on role.id = operator_role.role_id
  where operator_role.operator_id = p_operator_id;

  if p_role_codes is null then
    after_codes := before_codes;
  else
    select coalesce(array_agg(distinct candidate.code order by candidate.code), array[]::text[])
    into after_codes
    from unnest(p_role_codes) as candidate (code);

    if cardinality(after_codes) = 0 then
      return jsonb_build_object('status', 'last_role');
    end if;

    unknown_codes := ops.unknown_role_codes(after_codes);
    if cardinality(unknown_codes) > 0 then
      return jsonb_build_object('status', 'unknown_role', 'codes', to_jsonb(unknown_codes));
    end if;
  end if;

  effective_status := coalesce(p_status, target.status);

  effective_display_name := case
    when p_display_name is null then target.display_name
    else nullif(btrim(p_display_name), '')
  end;

  select coalesce(array_agg(distinct role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into before_permissions
  from ops.roles as role
  join ops.role_permissions as role_permission on role_permission.role_id = role.id
  where role.status = 'active'
    and role.code = any (before_codes);

  select coalesce(array_agg(distinct role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into after_permissions
  from ops.roles as role
  join ops.role_permissions as role_permission on role_permission.role_id = role.id
  where role.status = 'active'
    and role.code = any (after_codes);

  -- 自己不参与「还剩几个管理员」的基线：这一列只数别人，目标账号是否仍算管理员
  -- 由 effective_status 与 after_permissions 单独判断。混在一起写会漏掉
  -- 「把自己停用」与「把自己降级」这两种退化，它们结果相同但路径不同。
  select count(distinct operator.id)
  into others_with_manage
  from ops.operators as operator
  join ops.operator_roles as operator_role on operator_role.operator_id = operator.id
  join ops.roles as role on role.id = operator_role.role_id
    and role.status = 'active'
  join ops.role_permissions as role_permission on role_permission.role_id = role.id
  where operator.id <> p_operator_id
    and operator.status = 'active'
    and role_permission.permission_code = 'operator.manage';

  admins_before := others_with_manage + case
    when target.status = 'active' and 'operator.manage' = any (before_permissions) then 1
    else 0
  end;

  admins_after := others_with_manage + case
    when effective_status = 'active' and 'operator.manage' = any (after_permissions) then 1
    else 0
  end;

  -- 只在「变更造成归零」时拒绝。基线本来就是 0 的库（异常状态）不该因此连
  -- 无关的修改都做不了——那时该修的是数据，不是把接口锁死。
  if admins_before > 0 and admins_after = 0 then
    return jsonb_build_object('status', 'last_admin');
  end if;

  update ops.operators as operator
  set
    status = effective_status,
    display_name = effective_display_name,
    mfa_required = coalesce(p_mfa_required, operator.mfa_required),
    version = operator.version + 1,
    disabled_at = case when effective_status = 'disabled' then coalesce(operator.disabled_at, now()) else null end,
    -- 保留首次停用的原因：重复停用不改写历史，否则「为什么被停」会被后一次操作覆盖。
    disabled_reason = case when effective_status = 'disabled' then coalesce(operator.disabled_reason, p_reason) else null end,
    updated_at = now()
  where operator.id = p_operator_id;

  if p_role_codes is not null and after_codes <> before_codes then
    delete from ops.operator_roles as operator_role where operator_role.operator_id = p_operator_id;

    insert into ops.operator_roles (operator_id, role_id, granted_by)
    select p_operator_id, role.id, actor_id
    from ops.roles as role
    where role.code = any (after_codes)
      and role.status = 'active';

    -- 权限变了，`/session` 的 permissionVersion 必须跟着变——前端据此重新拉菜单。
    -- 不 +1 的话，被改权限的人要等到下一次登录才看见菜单变化，而那期间他会看到
    -- 「按钮在、点了 403」这种最难解释的失败。
    update ops.operators as operator
    set permission_version = operator.permission_version + 1
    where operator.id = p_operator_id;
  end if;

  select coalesce(array_agg(distinct permission_code order by permission_code), array[]::text[])
  into added_permissions
  from unnest(after_permissions) as permission_code
  where permission_code <> all (before_permissions);

  select coalesce(array_agg(distinct permission_code order by permission_code), array[]::text[])
  into removed_permissions
  from unnest(before_permissions) as permission_code
  where permission_code <> all (after_permissions);

  -- 显示名进摘要：口径变更（D-02）之后它是可以被改的字段之一，不进摘要就是
  -- 「改了但审计里看不见」。`before` 用的是行里的原值，不是调用方传的值。
  perform ops.write_audit(
    'operator.updated',
    'operator',
    p_operator_id,
    p_reason,
    jsonb_build_object(
      'status', target.status,
      'displayName', target.display_name,
      'roleCodes', to_jsonb(before_codes),
      'mfaRequired', target.mfa_required,
      'permissions', to_jsonb(before_permissions)
    ),
    jsonb_build_object(
      'status', effective_status,
      'displayName', effective_display_name,
      'roleCodes', to_jsonb(after_codes),
      'mfaRequired', coalesce(p_mfa_required, target.mfa_required),
      'permissions', to_jsonb(after_permissions)
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'operator', ops.operator_json(p_operator_id),
    'permissions_changed', jsonb_build_object(
      'added', to_jsonb(added_permissions),
      'removed', to_jsonb(removed_permissions)
    )
  );
end;
$$;


REVOKE ALL ON function ops.update_operator (
  uuid,
  integer,
  text,
  TEXT[],
  boolean,
  text,
  text,
  text
)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.update_operator (
  uuid,
  integer,
  text,
  TEXT[],
  boolean,
  text,
  text,
  text
) TO authenticated,
service_role;


COMMENT ON function ops.update_operator (
  uuid,
  integer,
  text,
  TEXT[],
  boolean,
  text,
  text,
  text
) IS '账号写侧。LAST_ROLE / LAST_ADMIN / 乐观锁三条不变量在写之前判定，返回信封而不是抛异常。p_display_name：NULL 不改，空串清空。';