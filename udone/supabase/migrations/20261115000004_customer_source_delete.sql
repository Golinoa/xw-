-- C2 客户来源维护：补表级 DELETE 授权 + 删除策略。
--
-- 现状：customer_sources 只授了 select / insert / update，连 DELETE 权限都没有，
-- 只有策略没有表权限时，删除会直接报 `permission denied for table`（不是 0 行），
-- 接口层会把它当成 500。两者必须一起补。
--
-- 删除本身受两道外键保护，不需要在策略里再写业务判断：
--   customers.source_id      ON DELETE RESTRICT —— 已被客户引用就删不掉；
--   customer_sources.parent_id ON DELETE RESTRICT —— 根来源下面还有子来源就删不掉。
-- 两者都会以 23503 冲突返回，接口层映射成 409 并给出可读原因。
GRANT DELETE ON public.customer_sources TO authenticated;


CREATE POLICY customer_sources_delete_writer ON public.customer_sources FOR DELETE TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('customer.write')
  )
);
