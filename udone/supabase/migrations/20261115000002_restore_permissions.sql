-- B2（第一步）：回收站所需的两个权限、两条「读已删除」策略、两个恢复函数。
--
-- 为什么单独加策略而不是放宽现有策略：20261029000004 的注释已经写明意图 ——
-- 「删除后不可读」是数据最小暴露的隘口，放宽它等于让所有调用方都能看到已删除数据。
-- 恢复能力必须与「读已删除」的能力绑定，因此另加一条带 customer.restore /
-- order.restore 权限的 SELECT 策略；Postgres 的多条 permissive SELECT 策略是 OR 关系，
-- 于是「有恢复权的人能看见已删除行」，其他人照旧看不见。
--
-- 权限只给 admin：恢复是纠错动作，能读已删除数据本身就是敏感能力。
-- operator 的 own 范围语义是「我负责的客户」，不是「我删掉的客户」。


INSERT INTO
  public.organization_role_permissions (role, permission)
VALUES
  ('admin', 'customer.restore'),
  ('admin', 'order.restore')
ON CONFLICT (role, permission) DO NOTHING;


-- 「读已删除」不是放开过滤条件，而是另一条策略：原策略里的 deleted_at IS NULL 保持不变。
CREATE POLICY customers_select_restorable ON public.customers FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.restore')
    )
  );


CREATE POLICY orders_select_restorable ON public.orders FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.restore')
    )
  );


-- 恢复函数：只清 deleted_at，不碰其它字段（恢复不是「回滚编辑」）。
-- 返回 uuid 便于调用方确认命中的是哪一行；没命中返回 NULL，不抛异常 ——
-- 与其它写函数的口径一致（不存在 = 空结果，权限不足才抛）。
CREATE OR REPLACE FUNCTION public.restore_customer (requested_customer_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  restored_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('customer.restore')) THEN
    RAISE EXCEPTION 'customer.restore is required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.customers AS customer
  SET
    deleted_at = NULL,
    updated_at = pg_catalog.now()
  WHERE
    customer.id = requested_customer_id
    AND customer.organization_id = current_org_id
    AND customer.deleted_at IS NOT NULL
  RETURNING
    customer.id INTO restored_id;
  RETURN restored_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.restore_order (requested_order_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  restored_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('order.restore')) THEN
    RAISE EXCEPTION 'order.restore is required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.orders AS orders
  SET
    deleted_at = NULL,
    updated_at = pg_catalog.now()
  WHERE
    orders.id = requested_order_id
    AND orders.organization_id = current_org_id
    AND orders.deleted_at IS NOT NULL
  RETURNING
    orders.id INTO restored_id;
  RETURN restored_id;
END;
$$;


REVOKE ALL ON FUNCTION public.restore_customer (uuid),
public.restore_order (uuid)
FROM
  PUBLIC;


GRANT EXECUTE ON FUNCTION public.restore_customer (uuid),
public.restore_order (uuid)
TO
  authenticated;
