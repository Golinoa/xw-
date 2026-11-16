-- A5 供应商行为测试：补删除能力所需的表级授权与策略。
--
-- 和 customer_sources 是同一个坑：`authenticated` 只授了 select / insert / update，
-- 没有 delete。只加策略的话，删除会直接报 `permission denied for table suppliers`
-- （硬报错，不是 0 行），接口层会把它当 500。
--
-- 删除的引用保护由外键承担：
--   order_payables.supplier_id ON DELETE RESTRICT —— 被应付行引用就删不掉（23503）。
-- 接口层映射成 409 OBJECT_REFERENCED，而不是把数据库错误直接抛给前端。
GRANT DELETE ON public.suppliers TO authenticated;


CREATE POLICY suppliers_delete_writer ON public.suppliers FOR DELETE TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('supplier.write')
  )
);
