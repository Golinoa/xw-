-- 运营身份的写侧：账号、角色、审计查询（契约 §5.1 的七个端点）。
--
-- 设计要点：
--
-- 1. 写路径全部是 SECURITY DEFINER RPC。operators / roles / role_permissions /
--    operator_roles 属于契约 §7.3 的 A2 类，authenticated 一行写权限都没有——不是
--    「忘了授予」，是故意不授。授予等于把「最后一个管理员不能被移除」「角色变更
--    必须写审计」交给调用方自觉，而调用方是 Worker：它可能是旧版本、可能被改坏、
--    也可能在某个分支里提前 return。
--
-- 2. 业务失败用返回值表达，不用 RAISE。理由是可分辨性：PostgREST 把任何非 2xx
--    都压成状态码，`RestConflictError` 拿不到 SQLSTATE 也不该拿到（上游错误正文
--    回显给调用方是另一类问题）。所以函数返回 `{status: '<词>'}` 的信封，成功时
--    才真的写。权限不足仍然 RAISE 42501——那不是业务分支，是「有人绕过了
--    requireOpsAuth」，必须留下痕迹而不是变成一个可被前端渲染的 409。
--
-- 3. 两条自锁不变量写在库里：
--      LAST_ROLE  账号至少要有一个启用中的角色，否则 TA 登录后一个动作码都没有，
--                 看起来像「系统坏了」而不是「权限没配」。
--      LAST_ADMIN 不能把最后一个具备 operator.manage 的有效账号移出管理员集合。
--                 少了它，一次误操作之后没有任何人能再改回来，只能连数据库。
--    两条都在**写之前**算完并返回，不靠事务回滚兜底：回滚能撤销写入，但撤销不了
--    已经返回给调用方的 500，而那会让人以为是故障而不是拒绝。
--
-- 4. 审计的前后摘要由 RPC 自己拼，调用方没有传入 before/after 的口子。可传入的
--    摘要等于可伪造的摘要，而审计的全部价值在于它记录的是「实际发生了什么」。
CREATE OR REPLACE FUNCTION ops.unknown_role_codes (p_codes TEXT[]) returns TEXT[] language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(array_agg(distinct candidate.code order by candidate.code), array[]::text[])
  from unnest(p_codes) as candidate (code)
  where not exists (
    select 1
    from ops.roles as role
    where role.code = candidate.code
      and role.status = 'active'
  );
$$;


CREATE OR REPLACE FUNCTION ops.unknown_permission_codes (p_codes TEXT[]) returns TEXT[] language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(array_agg(distinct candidate.code order by candidate.code), array[]::text[])
  from unnest(p_codes) as candidate (code)
  where not exists (
    select 1
    from ops.permissions as permission
    where permission.code = candidate.code
  );
$$;


-- 账号的对外形状（列表项、PATCH 响应、邀请响应共用一处）。
--
-- 与 `get_current_ops_context()` 一样返回数据库列名，小驼峰映射交给 Worker 显式写：
-- 让 jsonb 直接产出契约字段名，等于把契约知识埋进 SQL，字段改名时最该报错的那一层
-- （出站校验）反而看不见。
CREATE OR REPLACE FUNCTION ops.operator_json (p_operator_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', operator.id,
    'email', operator.email,
    'display_name', operator.display_name,
    'status', operator.status,
    'mfa_required', operator.mfa_required,
    'version', operator.version,
    'last_login_at', operator.last_login_at,
    'roles', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('code', role.code, 'name', role.name)
          order by role.code
        )
        from ops.operator_roles as operator_role
        join ops.roles as role on role.id = operator_role.role_id
        where operator_role.operator_id = operator.id
          and role.status = 'active'
      ),
      '[]'::jsonb
    )
  )
  from ops.operators as operator
  where operator.id = p_operator_id;
$$;


CREATE OR REPLACE FUNCTION ops.role_json (p_role_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', role.id,
    'code', role.code,
    'name', role.name,
    -- 契约 U-22 定稿：`description` 可空字符串，不是 null。前端直接渲染它。
    'description', coalesce(role.description, ''),
    'is_system', role.is_system,
    'status', role.status,
    'permissions', coalesce(
      (
        select jsonb_agg(role_permission.permission_code order by role_permission.permission_code)
        from ops.role_permissions as role_permission
        where role_permission.role_id = role.id
      ),
      '[]'::jsonb
    )
  )
  from ops.roles as role
  where role.id = p_role_id;
$$;


-- ── GET /operators ──────────────────────────────────────────────────────────
-- 过滤条件只写一次：count 与取页共用同一个 CTE。写两遍的代价不是重复，而是
-- 某天给其中一个加了条件——总数与列表从此不是同一批行，而分页器到最后一页才露馅。
CREATE OR REPLACE FUNCTION ops.list_operators (
  p_keyword text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_role_code text DEFAULT NULL,
  p_sort text DEFAULT 'email',
  p_order text DEFAULT 'asc',
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  page_offset integer := (greatest(coalesce(p_page, 1), 1) - 1) * page_size;
  direction text := case when lower(coalesce(p_order, 'asc')) = 'desc' then 'desc' else 'asc' end;
begin
  perform ops.require_permission('operator.read');

  return (
    with filtered as (
      select operator.id, operator.email, operator.display_name, operator.status, operator.created_at, operator.last_login_at
      from ops.operators as operator
      where (
          p_status is null
          or operator.status = p_status
        )
        and (
          p_keyword is null
          or btrim(p_keyword) = ''
          or operator.email ilike '%' || btrim(p_keyword) || '%'
          or coalesce(operator.display_name, '') ilike '%' || btrim(p_keyword) || '%'
        )
        and (
          p_role_code is null
          or exists (
            select 1
            from ops.operator_roles as operator_role
            join ops.roles as role on role.id = operator_role.role_id
            where operator_role.operator_id = operator.id
              and role.code = p_role_code
          )
        )
    ), page as (
      select *
      from filtered
      order by
        -- 排序键必须走白名单。把列名拼进 SQL 是注入，把列名当参数需要这种
        -- CASE 阶梯——每个方向一个分支，未命中的分支是 NULL，不参与排序。
        case when p_sort = 'email' and direction = 'asc' then filtered.email end asc nulls last,
        case when p_sort = 'email' and direction = 'desc' then filtered.email end desc nulls last,
        case when p_sort = 'display_name' and direction = 'asc' then filtered.display_name end asc nulls last,
        case when p_sort = 'display_name' and direction = 'desc' then filtered.display_name end desc nulls last,
        case when p_sort = 'created_at' and direction = 'asc' then filtered.created_at end asc nulls last,
        case when p_sort = 'created_at' and direction = 'desc' then filtered.created_at end desc nulls last,
        case when p_sort = 'last_login_at' and direction = 'asc' then filtered.last_login_at end asc nulls last,
        case when p_sort = 'last_login_at' and direction = 'desc' then filtered.last_login_at end desc nulls last,
        -- 兜底：其余排序键一律按邮箱升序，且最后一列唯一，翻页不会漏行或重行。
        filtered.email asc,
        filtered.id asc
      limit page_size
      offset page_offset
    )
    select jsonb_build_object(
      'items', coalesce(
        (select jsonb_agg(ops.operator_json(page.id) order by page.email, page.id) from page),
        '[]'::jsonb
      ),
      'total', (select count(*) from filtered)
    )
  );
end;
$$;


-- ── POST /operators/invitations ─────────────────────────────────────────────
-- `p_user_id` 由 Worker 先从 GoTrue 的 `auth.admin` 拿到，再带进来。库不调外部服务，
-- 也不给 authenticated 写 `auth.users` 的能力；`ops.operators.user_id` 的外键到
-- `auth.users` 因此仍然是一条真约束，而不是「反正对不上也能插」。
CREATE OR REPLACE FUNCTION ops.invite_operator (
  p_user_id uuid,
  p_email text,
  p_role_codes TEXT[],
  p_reason text,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid;
  unknown_codes text[];
  normalized_email text := lower(btrim(coalesce(p_email, '')));
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

  insert into ops.operators (user_id, email, status, invited_by)
  values (p_user_id, normalized_email, 'invited', actor_id)
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
    jsonb_build_object('email', normalized_email, 'roleCodes', to_jsonb(p_role_codes)),
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


-- ── PATCH /operators/{operatorId} ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.update_operator (
  p_operator_id uuid,
  p_expected_version integer,
  p_status text DEFAULT NULL,
  p_role_codes TEXT[] DEFAULT NULL,
  p_mfa_required boolean DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
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

  perform ops.write_audit(
    'operator.updated',
    'operator',
    p_operator_id,
    p_reason,
    jsonb_build_object(
      'status', target.status,
      'roleCodes', to_jsonb(before_codes),
      'mfaRequired', target.mfa_required,
      'permissions', to_jsonb(before_permissions)
    ),
    jsonb_build_object(
      'status', effective_status,
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


-- ── GET /roles ──────────────────────────────────────────────────────────────
-- 契约 §5.1 的 `/roles` 没有分页，返回 `items[]` 就够：角色是配置项，数量是个位数。
-- 加一个 total 会让「有没有第二页」变成前端必须判断的问题。
CREATE OR REPLACE FUNCTION ops.list_roles () returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
begin
  perform ops.require_permission('operator.read');

  return jsonb_build_object(
    'items', coalesce(
      (
        select jsonb_agg(ops.role_json(role.id) order by role.is_system desc, role.code)
        from ops.roles as role
      ),
      '[]'::jsonb
    )
  );
end;
$$;


-- ── POST /roles ─────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_role (
  p_code text,
  p_name text,
  p_description text,
  p_permission_codes TEXT[],
  p_reason text,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  new_id uuid;
  unknown_codes text[];
  normalized_code text := btrim(coalesce(p_code, ''));
begin
  perform ops.require_permission('role.manage');

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'reason_required');
  end if;

  if exists (
    select 1
    from ops.roles as role
    where role.code = normalized_code
  ) then
    return jsonb_build_object('status', 'role_code_exists');
  end if;

  unknown_codes := ops.unknown_permission_codes(p_permission_codes);

  if cardinality(unknown_codes) > 0 then
    return jsonb_build_object('status', 'unknown_permission', 'codes', to_jsonb(unknown_codes));
  end if;

  insert into ops.roles (code, name, description, is_system)
  values (normalized_code, btrim(p_name), nullif(btrim(coalesce(p_description, '')), ''), false)
  returning id into new_id;

  insert into ops.role_permissions (role_id, permission_code)
  select new_id, candidate.code
  from unnest(p_permission_codes) as candidate (code)
  on conflict do nothing;

  perform ops.write_audit(
    'role.created',
    'role',
    new_id,
    p_reason,
    null,
    jsonb_build_object(
      'code', normalized_code,
      'name', btrim(p_name),
      'permissions', to_jsonb(p_permission_codes)
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'role', ops.role_json(new_id));
end;
$$;


-- ── PATCH /roles/{roleId} ───────────────────────────────────────────────────
-- 参数里没有 `code`，这是「系统角色不可改 code」的落地方式：不是运行时判断
-- `is_system`，而是让「改 code」这件事在接口形状上不存在。迁移 seed 出来的六个
-- 角色 code 是权限映射的锚点（`platform_admin` 拿满 39 个码靠的是 code）。
CREATE OR REPLACE FUNCTION ops.update_role (
  p_role_id uuid,
  p_name text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_permission_codes TEXT[] DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  target ops.roles;
  before_permissions text[];
  after_permissions text[];
  unknown_codes text[];
  effective_status text;
  holders integer;
  others_with_manage integer;
  admins_before integer;
  admins_after integer;
begin
  perform ops.require_permission('role.manage');

  if p_reason is null or btrim(p_reason) = '' then
    return jsonb_build_object('status', 'reason_required');
  end if;

  select * into target
  from ops.roles as role
  where role.id = p_role_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(array_agg(distinct role_permission.permission_code order by role_permission.permission_code), array[]::text[])
  into before_permissions
  from ops.role_permissions as role_permission
  where role_permission.role_id = p_role_id;

  if p_permission_codes is null then
    after_permissions := before_permissions;
  else
    unknown_codes := ops.unknown_permission_codes(p_permission_codes);

    if cardinality(unknown_codes) > 0 then
      return jsonb_build_object('status', 'unknown_permission', 'codes', to_jsonb(unknown_codes));
    end if;

    select coalesce(array_agg(distinct candidate.code order by candidate.code), array[]::text[])
    into after_permissions
    from unnest(p_permission_codes) as candidate (code);
  end if;

  effective_status := coalesce(p_status, target.status);

  select count(distinct operator.id)
  into holders
  from ops.operator_roles as operator_role
  join ops.operators as operator on operator.id = operator_role.operator_id
  where operator_role.role_id = p_role_id
    and operator.status = 'active';

  -- 通过**其它**角色拿到 operator.manage 的人数。这个角色本身的变化不在里面，
  -- 否则「把这个角色的 manage 摘掉」会因为算进了自己而永远不触发 LAST_ADMIN。
  select count(distinct operator.id)
  into others_with_manage
  from ops.operators as operator
  join ops.operator_roles as operator_role on operator_role.operator_id = operator.id
  join ops.roles as role on role.id = operator_role.role_id
    and role.id <> p_role_id
    and role.status = 'active'
  join ops.role_permissions as role_permission on role_permission.role_id = role.id
  where operator.status = 'active'
    and role_permission.permission_code = 'operator.manage';

  admins_before := others_with_manage + case
    when target.status = 'active' and 'operator.manage' = any (before_permissions) then holders
    else 0
  end;

  admins_after := others_with_manage + case
    when effective_status = 'active' and 'operator.manage' = any (after_permissions) then holders
    else 0
  end;

  if admins_before > 0 and admins_after = 0 then
    return jsonb_build_object('status', 'last_admin');
  end if;

  update ops.roles as role
  set
    name = coalesce(nullif(btrim(p_name), ''), role.name),
    description = case
      when p_description is null then role.description
      else nullif(btrim(p_description), '')
    end,
    status = effective_status,
    updated_at = now()
  where role.id = p_role_id;

  if p_permission_codes is not null then
    delete from ops.role_permissions as role_permission where role_permission.role_id = p_role_id;

    insert into ops.role_permissions (role_id, permission_code)
    select p_role_id, candidate.code
    from unnest(p_permission_codes) as candidate (code)
    on conflict do nothing;
  end if;

  if after_permissions <> before_permissions or effective_status <> target.status then
    update ops.operators as operator
    set permission_version = operator.permission_version + 1
    where operator.id in (
      select operator_role.operator_id
      from ops.operator_roles as operator_role
      where operator_role.role_id = p_role_id
    );
  end if;

  -- 契约 §4 要求角色权限变更记录前后摘要，且 action 单独一个词。改名与改状态不算
  -- 权限变更，用 `role.updated` 分开记——两类事件混在一个 action 下，按 action
  -- 筛查「谁动过权限」时会把改名也筛出来。
  perform ops.write_audit(
    case
      when after_permissions <> before_permissions then 'role.permissions_changed'
      else 'role.updated'
    end,
    'role',
    p_role_id,
    p_reason,
    jsonb_build_object(
      'name', target.name,
      'description', coalesce(target.description, ''),
      'status', target.status,
      'permissions', to_jsonb(before_permissions)
    ),
    jsonb_build_object(
      'name', coalesce(nullif(btrim(p_name), ''), target.name),
      'description', coalesce(
        case
          when p_description is null then target.description
          else nullif(btrim(p_description), '')
        end,
        ''
      ),
      'status', effective_status,
      'permissions', to_jsonb(after_permissions)
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'role', ops.role_json(p_role_id),
    'before_permissions', to_jsonb(before_permissions),
    'after_permissions', to_jsonb(after_permissions)
  );
end;
$$;


-- ── GET /audit-events ───────────────────────────────────────────────────────
-- actor 左连接：`actor_operator_id` 在账号被删后置空（ON DELETE SET NULL），
-- service_role 写入时两列都为空。用内连接会把「系统写的」那些事件整行吞掉，
-- 而恰恰是这些行最需要被看见。
CREATE OR REPLACE FUNCTION ops.list_audit_events (
  p_actor_operator_id uuid DEFAULT NULL,
  p_action text DEFAULT NULL,
  p_entity_type text DEFAULT NULL,
  p_entity_id uuid DEFAULT NULL,
  p_request_id text DEFAULT NULL,
  p_from timestamptz DEFAULT NULL,
  p_to timestamptz DEFAULT NULL,
  p_page integer DEFAULT 1,
  p_page_size integer DEFAULT 20
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  page_size integer := least(greatest(coalesce(p_page_size, 20), 1), 100);
  page_offset integer := (greatest(coalesce(p_page, 1), 1) - 1) * page_size;
begin
  perform ops.require_permission('audit.read');

  return (
    with filtered as (
      select event.*
      from ops.audit_events as event
      where (
          p_actor_operator_id is null
          or event.actor_operator_id = p_actor_operator_id
        )
        and (
          p_action is null
          or event.action = p_action
        )
        and (
          p_entity_type is null
          or event.entity_type = p_entity_type
        )
        and (
          p_entity_id is null
          or event.entity_id = p_entity_id
        )
        and (
          p_request_id is null
          or event.request_id = p_request_id
        )
        and (
          p_from is null
          or event.created_at >= p_from
        )
        and (
          p_to is null
          or event.created_at <= p_to
        )
    ), page as (
      select *
      from filtered
      order by filtered.created_at desc, filtered.id desc
      limit page_size
      offset page_offset
    )
    select jsonb_build_object(
      'items', coalesce(
        (
          select jsonb_agg(
            jsonb_build_object(
              'id', page.id,
              'actor', case
                when actor.id is null then null
                else jsonb_build_object('id', actor.id, 'display_name', actor.display_name)
              end,
              'action', page.action,
              'entity_type', page.entity_type,
              'entity_id', page.entity_id,
              'reason', page.reason,
              'before_summary', page.before_summary,
              'after_summary', page.after_summary,
              'request_id', page.request_id,
              'created_at', page.created_at
            )
            order by page.created_at desc, page.id desc
          )
          from page
          left join ops.operators as actor on actor.id = page.actor_operator_id
        ),
        '[]'::jsonb
      ),
      'total', (select count(*) from filtered)
    )
  );
end;
$$;


-- ── 授权 ────────────────────────────────────────────────────────────────────
-- 七个入口给 authenticated 与 service_role。调用方拿不到「跳过判定」的路径：
-- 每个函数第一句都是 `ops.require_permission`，权限不足直接 42501。
REVOKE ALL ON function ops.unknown_role_codes (TEXT[])
FROM
  public,
  anon;


REVOKE ALL ON function ops.unknown_permission_codes (TEXT[])
FROM
  public,
  anon;


-- 三个形状函数没有任何权限判定，**必须**对所有非属主角色关闭。
-- 漏关一个，任何一个登录用户都能 `rpc/operator_json` 拿到全量运营账号。
REVOKE ALL ON function ops.operator_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.role_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_operators (text, text, text, text, text, integer, integer)
FROM
  public,
  anon;


REVOKE ALL ON function ops.invite_operator (uuid, text, TEXT[], text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_operator (uuid, integer, text, TEXT[], boolean, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_roles ()
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_role (text, text, text, TEXT[], text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_role (uuid, text, text, TEXT[], text, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_audit_events (
  uuid,
  text,
  text,
  uuid,
  text,
  timestamptz,
  timestamptz,
  integer,
  integer
)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.list_operators (text, text, text, text, text, integer, integer) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.invite_operator (uuid, text, TEXT[], text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_operator (uuid, integer, text, TEXT[], boolean, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_roles () TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_role (text, text, text, TEXT[], text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_role (uuid, text, text, TEXT[], text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_audit_events (
  uuid,
  text,
  text,
  uuid,
  text,
  timestamptz,
  timestamptz,
  integer,
  integer
) TO authenticated,
service_role;


COMMENT ON function ops.update_operator (uuid, integer, text, TEXT[], boolean, text, text) IS '账号写侧。LAST_ROLE / LAST_ADMIN / 乐观锁三条不变量在写之前判定，返回信封而不是抛异常。';