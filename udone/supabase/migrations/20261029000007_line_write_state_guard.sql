-- 明细行的写入策略补上父订单状态校验。
--
-- 问题：应收/应付明细的写策略只校验了「同组织 + order.write + 父订单可见」，
-- 没有校验父订单状态。API 走 update_order_with_items 时会被函数里的
-- ORDER_STATE_CONFLICT 挡住，但直连 PostgREST（持用户 JWT）仍然可以给
-- 已锁团（completed）或已取消（cancelled）的订单增删改金额行。
-- 金额行是财务事实，完成后还能改它，等于利润和报表都可以被事后篡改。
--
-- 判定口径与状态机一致：lock 即 active -> completed，没有独立的锁定列，
-- 所以「可写」= status in ('booking', 'active')。
-- cancelled 也不可写；restore 回到 booking/active 后自然恢复可写。
--
-- 软删除与数据范围不在这里重复：EXISTS 子查询会应用 orders 自己的 SELECT 策略，
-- 父订单一旦被软删除或不在当前用户的数据范围内，这里就已经不成立。
--
-- 本迁移只收紧，不放宽。写错的表现是「该改的也改不了」（报 42501），
-- 而不是把不该改的放过去。
DROP POLICY order_receivables_insert_writer ON public.order_receivables;


DROP POLICY order_receivables_update_writer ON public.order_receivables;


DROP POLICY order_receivables_delete_writer ON public.order_receivables;


DROP POLICY order_payables_insert_writer ON public.order_payables;


DROP POLICY order_payables_update_writer ON public.order_payables;


DROP POLICY order_payables_delete_writer ON public.order_payables;


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
        AND parent_order.status IN ('booking', 'active')
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
        AND parent_order.status IN ('booking', 'active')
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
        AND parent_order.status IN ('booking', 'active')
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
      AND parent_order.status IN ('booking', 'active')
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
        AND parent_order.status IN ('booking', 'active')
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
        AND parent_order.status IN ('booking', 'active')
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
        AND parent_order.status IN ('booking', 'active')
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
      AND parent_order.status IN ('booking', 'active')
  )
);