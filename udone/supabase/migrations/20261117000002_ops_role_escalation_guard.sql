-- 自我提权防护：授予集合不得超出调用者已有的权限
--
-- 漏洞原状：`ops.create_role` 只校验「权限码是否存在」，不校验「我有没有」。
-- 持有 `role.manage` + `operator.manage` 的人可以建一个全权角色，再把它分给自己——
-- 唯一的自锁 `LAST_ADMIN` 是防「把自己降没」，防不了「把自己升上去」。
--
-- 为什么用触发器而不是改两个 RPC：写 `role_permissions` 的路径有两条
-- （`create_role`、`update_role`），将来还可能有第三条；触发器挂在表上，
-- 一次覆盖全部入口，也不用把两个两百行的函数整段复制一遍。
--
-- 两个「不拦」的例外，都是刻意的：
--   1. 没有会话（`auth.uid()` 为空）——迁移、种子、后台维护。那时不存在「调用者」，
--      也就没有可比较的权限集合；拦了等于把部署流程锁死。
--   2. 会话没有 SET ROLE 过，或 SET ROLE 成了数据库属主（postgres / supabase_admin）——
--      迁移、种子、psql 维护都属于这一类，DBA 本来就能直接改表，拦它只会让运维脚本莫名失败。
--      判的是 `current_setting('role')` 而不是 `current_user`：RPC 是 SECURITY DEFINER，
--      函数体内 `current_user` 一律是属主，分辨不出调用来源。
--   3. `is_system` 角色由迁移直接写入，走的正是上面第 1 条路。
--
-- ⚠️ 本迁移只堵住「建角色时扩权」这一半。另一半——把**已有的**全权角色分配给
-- 自己或别人——没有在这里堵：`ops.update_operator` 是「先删掉调用者现有角色、
-- 再插入新角色」，插入时调用者自己的权限已经是空的，表级触发器拿不到「删除前」
-- 的基线，判下去会把正常的分角色也一起拦掉。
-- 那一半要在 `ops.update_operator` 内部做语义检查（新增权限 ⊆ 调用者已有权限），
-- 属于另一个改动，见 `.harness/journal/2026-11-17-role-escalation-guard.md`。
--
-- 分配角色（`operator_roles`）同样要拦：只拦「建角色」而不管「分角色」的话，
-- 提权只需要两步里的第二步——把已有的全权角色分给自己。

CREATE OR REPLACE FUNCTION ops.privileged_session () returns boolean language sql stable
SET
  search_path = '' AS $$
  -- `current_setting('role')` 读的是当前生效的 SET ROLE 目标：
  -- 迁移/种子/psql 维护没设过（none）；PostgREST 会 SET ROLE 成 authenticated / service_role。
  select coalesce(current_setting('role', true), 'none') in ('none', 'postgres', 'supabase_admin');
$$;


CREATE OR REPLACE FUNCTION ops.caller_permission_codes () returns TEXT[] language sql stable security definer
SET
  search_path = '' AS $$
  select coalesce(
    (select context.permission_codes from ops.get_current_ops_context() as context),
    array[]::text[]
  );
$$;


CREATE OR REPLACE FUNCTION ops.enforce_role_permission_scope () returns trigger language plpgsql security definer
SET
  search_path = '' AS $$
declare
  caller_codes text[];
begin
  if (select auth.uid()) is null or ops.privileged_session () then
    return new;
  end if;

  caller_codes := ops.caller_permission_codes();

  if new.permission_code <> all (caller_codes) then
    raise exception 'permission_out_of_scope'
      using
        errcode = '42501',
        detail = format(
          'cannot grant %s: caller does not hold it',
          new.permission_code
        ),
        hint = '只能授予自己已有的权限；需要更高权限时由已有该权限的人操作';
  end if;

  return new;
end;
$$;


DROP TRIGGER IF EXISTS role_permissions_scope_guard ON ops.role_permissions;

CREATE TRIGGER role_permissions_scope_guard
BEFORE INSERT ON ops.role_permissions FOR EACH ROW
EXECUTE FUNCTION ops.enforce_role_permission_scope ();



-- 新建函数默认对 PUBLIC 有 EXECUTE；仓库有断言专门查这件事（A2），
-- 只写 GRANT 等于没拦。
REVOKE ALL ON function ops.privileged_session () FROM public, anon, authenticated;

REVOKE ALL ON function ops.caller_permission_codes () FROM public, anon, authenticated;

REVOKE ALL ON function ops.enforce_role_permission_scope () FROM public, anon, authenticated;
