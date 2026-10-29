-- 收紧应收/应付明细的数据范围（R-FIN-01、SECURITY.md 数据范围）。
--
-- 问题：明细表的 SELECT 策略只校验了「同组织 + order.read」，没有校验 own/all 数据范围；
-- 而 orders 的 SELECT 策略是校验了的。结果是 scope=own 的操作员虽然看不到别人的订单，
-- 却能直接读到那些订单的应收应付金额。
--
-- 明细表没有 created_by，无法照抄 orders 的 `created_by = auth.uid()` 判断，
-- 只能顺着父订单判定：策略里的 EXISTS 子查询会再套一层 orders 自己的 RLS，
-- 因此「父订单可见」这个条件与订单列表的范围规则天然一致，不需要在两处各写一遍规则。
--
-- 另一个必须一起改的点：原来的写策略是 FOR ALL，PostgreSQL 的宽松策略之间是 OR 关系，
-- 光收紧 SELECT 策略没用——FOR ALL 的写策略同样覆盖 SELECT，会把范围检查绕过去。
-- 所以这里把 FOR ALL 拆成 insert / update / delete 三条独立策略。
--
-- 注意：本迁移只收紧权限，不放宽任何东西。若策略写错，表现是明细读不出来（500），
-- 而不是把别人的数据放出去。
DROP POLICY order_receivables_select_reader ON public.order_receivables;


DROP POLICY order_receivables_write_writer ON public.order_receivables;


DROP POLICY order_payables_select_reader ON public.order_payables;


DROP POLICY order_payables_write_writer ON public.order_payables;


CREATE POLICY order_receivables_select_scoped ON public.order_receivables FOR
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
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_receivables.order_id
    )
  );


CREATE POLICY order_receivables_insert_writer ON public.order_receivables FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_receivables.order_id
    )
  );


CREATE POLICY order_receivables_update_writer ON public.order_receivables
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_receivables.order_id
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
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_receivables.order_id
    )
  );


CREATE POLICY order_receivables_delete_writer ON public.order_receivables FOR delete TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('order.write')
  )
  AND EXISTS (
    SELECT
      1
    FROM
      public.orders AS parent_order
    WHERE
      parent_order.id = order_receivables.order_id
  )
);


CREATE POLICY order_payables_select_scoped ON public.order_payables FOR
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
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_payables.order_id
    )
  );


CREATE POLICY order_payables_insert_writer ON public.order_payables FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_payables.order_id
    )
  );


CREATE POLICY order_payables_update_writer ON public.order_payables
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_payables.order_id
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
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS parent_order
      WHERE
        parent_order.id = order_payables.order_id
    )
  );


CREATE POLICY order_payables_delete_writer ON public.order_payables FOR delete TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('order.write')
  )
  AND EXISTS (
    SELECT
      1
    FROM
      public.orders AS parent_order
    WHERE
      parent_order.id = order_payables.order_id
  )
);