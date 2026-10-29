-- 软删除的行不应该在数据库层可读（SECURITY.md 数据最小暴露）。
--
-- 现状：customers / orders 的 SELECT 策略只校验组织、权限与数据范围，没有校验
-- deleted_at。API 层是靠查询串里的 `deleted_at=is.null` 过滤的，这意味着
-- 「谁的查询里忘了带这个条件，谁就能读到已删除的数据」——把正确性挂在调用方
-- 的自觉上，靠不住。RLS 才是唯一的隘口。
--
-- 另一个现实理由：Supabase 的 PostgREST 用用户 JWT 直接可达，API 只是其中一个
-- 调用方。策略不挡，就只是「我们的代码目前没这么查」。
--
-- 副作用（已同步处理）：API 的软删除依赖 `Prefer: return=representation` 判断
-- 命中行数，行一旦被策略隐藏，UPDATE ... RETURNING 会返回 0 行，
-- 表现为「删除成功却回 404」。因此 customer-service 的 remove 改为
-- 先确认存在、再用 return=minimal 提交，不再依赖返回体。
--
-- 后续做「回收站」时不要放宽这两条策略，应另加一条带 customer.restore /
-- order.restore 权限的 SELECT 策略，让恢复能力与读取已删除数据的能力绑定。
DROP POLICY customers_select_scoped ON public.customers;


CREATE POLICY customers_select_scoped ON public.customers FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.read')
    )
    AND (
      (
        SELECT
          public.current_data_scope ()
      ) = 'all'
      OR created_by = (
        SELECT
          auth.uid ()
      )
    )
    AND deleted_at IS NULL
  );


DROP POLICY orders_select_scoped ON public.orders;


CREATE POLICY orders_select_scoped ON public.orders FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.read')
    )
    AND (
      (
        SELECT
          public.current_data_scope ()
      ) = 'all'
      OR created_by = (
        SELECT
          auth.uid ()
      )
    )
    AND deleted_at IS NULL
  );