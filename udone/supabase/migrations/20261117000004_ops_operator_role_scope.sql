-- 提权防护的另一半：分配角色时，新增的权限必须是调用者自己有的
--
-- 上一个迁移（20261117000002）堵住了「建角色时扩权」；这一半堵的是
-- 「把已有的全权角色分给自己」——只拦一半等于没拦，提权只需要第二步。
--
-- 源头是 20261030000006 里那份 8 参数版本（它 DROP 掉了 000005 的 7 参数版）。
-- 抄错版本会让库里出现两个 overload：调用方按 6 个位置参数调用时直接
-- 「function is not unique」，这是本次实际踩到的坑。
--
-- 为什么必须在这里判而不是挂触发器：本函数是「先删调用者现有角色、再插新角色」，
-- 插入那一刻调用者自己的权限已被删空，表级触发器拿不到删除前的基线。
-- 第一版试过 operator_roles 触发器，它把正常的多角色分配也一起拦了，已撤。
--
-- 返回 jsonb status 而不是抛异常：本函数所有失败分支都是这个形状
-- （reason_required / version_mismatch / unknown_role / last_admin），
-- 路由按 status 映射 HTTP 码；混入异常会让调用方多一条解析路径。
--
-- 豁免：ops.privileged_session()——迁移、种子、DBA 会话，那里没有「调用者」。

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
  caller_codes text[];
  scope_violations text[];
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

  -- 提权防护的另一半：新增的权限必须是调用者自己有的。
  -- 只拦「建角色」不够——把已有的全权角色分给自己，靠的就是这一步；
  -- 而这一步只有 RPC 内部判得了：本函数是「先删角色再插新角色」，
  -- 表级触发器在插入时已经看不到调用者原来的权限（那时已被删空）。
  if not ops.privileged_session () then
    select coalesce(array_agg(distinct candidate.code order by candidate.code), array[]::text[])
    into added_permissions
    from unnest(after_permissions) as candidate (code)
    where candidate.code <> all (before_permissions);

    if cardinality(added_permissions) > 0 then
      caller_codes := ops.caller_permission_codes();

      select coalesce(array_agg(distinct candidate.code order by candidate.code), array[]::text[])
      into scope_violations
      from unnest(added_permissions) as candidate (code)
      where candidate.code <> all (caller_codes);

      if cardinality(scope_violations) > 0 then
        return jsonb_build_object(
          'status', 'permission_out_of_scope',
          'codes', to_jsonb(scope_violations)
        );
      end if;
    end if;
  end if;

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
