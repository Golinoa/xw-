-- C3 标签管理补全：改名能力、删除能力、删除保护。
--
-- 三处缺口一起补，缺任何一处标签都不可管理：
--   1. customer_tags 只有 select / insert 策略，**连 UPDATE 策略都没有** —— 改名会被
--      策略静默挡成 0 行（PATCH 返回空数组），接口层只能报 404，与「标签不存在」无法区分。
--   2. 表级没有 GRANT DELETE（C2 踩过同一个坑）：只有策略没有表权限时，删除直接报
--      `permission denied for table`，接口层会当 500 处理。
--   3. customer_tag_links.tag_id 原本是 ON DELETE CASCADE：删标签会**静默删掉所有客户的
--      打标记录**且不报任何错误。标签是客户的分类依据，被引用时应当删除失败并要求先解除引用，
--      因此收紧为 RESTRICT（23503 → 接口层 409 OBJECT_REFERENCED）。
GRANT DELETE ON public.customer_tags TO authenticated;


CREATE POLICY customer_tags_update_writer ON public.customer_tags
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
    )
  )
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
    )
  );


CREATE POLICY customer_tags_delete_writer ON public.customer_tags FOR DELETE TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('customer.write')
  )
);


ALTER TABLE public.customer_tag_links
DROP CONSTRAINT customer_tag_links_tag_fk;


ALTER TABLE public.customer_tag_links
ADD CONSTRAINT customer_tag_links_tag_fk FOREIGN KEY (tag_id, organization_id) REFERENCES public.customer_tags (id, organization_id) ON DELETE RESTRICT;