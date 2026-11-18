-- C8 报表与统一口径（R-REPORT-01）。
--
-- 需求最关键的一句：报表、仪表盘、导出使用同一统计服务或口径函数，避免数字不一致。
-- 本迁移提供一个函数 `public.tenant_report(from, to)` 返回整份报表 JSONB，
-- API 的列表、仪表盘与 CSV 导出全都调它——口径只有一个实现。
--
-- 口径（写在这里，谁都不许在前端重算）：
--   1. 按订单 created_at 过滤，页面显示「创建日期」；
--   2. 默认含 booking / active / completed 并分状态展示；cancelled 默认排除，
--      但报表函数不替调用方决定——调用方传 include_cancelled 显式选择；
--   3. 财务统计只计已确认金额（confirmed_amount），待审金额单列为在途（pending_amount）；
--   4. 供应商统计沿用同一订单范围与同一日期字段。
CREATE OR REPLACE FUNCTION public.tenant_report (
  requested_from date,
  requested_to date,
  requested_include_cancelled boolean DEFAULT FALSE
) RETURNS jsonb LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  WITH scoped_orders AS (
    SELECT
      order_row.id,
      order_row.status,
      order_row.receivable_total,
      order_row.payable_total,
      order_row.profit
    FROM public.orders AS order_row
    WHERE order_row.organization_id = public.current_organization_id ()
      AND order_row.deleted_at IS NULL
      AND order_row.created_at >= requested_from
      AND order_row.created_at < (requested_to + 1)
      AND (
        requested_include_cancelled
        OR order_row.status <> 'cancelled'
      )
  ),
  scoped_receivables AS (
    SELECT
      pg_catalog.sum(line.confirmed_amount) AS confirmed,
      pg_catalog.sum(line.pending_amount) AS pending
    FROM public.order_receivables AS line
    WHERE line.organization_id = public.current_organization_id ()
      AND line.order_id IN (
        SELECT id
        FROM scoped_orders
      )
  ),
  scoped_payables AS (
    SELECT
      pg_catalog.sum(line.confirmed_amount) AS confirmed,
      pg_catalog.sum(line.pending_amount) AS pending
    FROM public.order_payables AS line
    WHERE line.organization_id = public.current_organization_id ()
      AND line.order_id IN (
        SELECT id
        FROM scoped_orders
      )
  ),
  status_breakdown AS (
    SELECT
      pg_catalog.jsonb_object_agg(status, cnt) AS counts
    FROM (
      SELECT status, pg_catalog.count (*) AS cnt
      FROM scoped_orders
      GROUP BY status
    ) AS grouped
  )
  SELECT pg_catalog.jsonb_build_object(
    'dateField', 'createdAt',
    'from', requested_from,
    'to', requested_to,
    'includeCancelled', requested_include_cancelled,
    'overview', pg_catalog.jsonb_build_object(
      'orderCount', (SELECT pg_catalog.count (*) FROM scoped_orders),
      'receivableTotal', COALESCE((SELECT pg_catalog.sum (receivable_total) FROM scoped_orders), 0),
      'payableTotal', COALESCE((SELECT confirmed FROM scoped_payables), 0),
      'profit', COALESCE((SELECT pg_catalog.sum (profit) FROM scoped_orders), 0)
    ),
    'finance', pg_catalog.jsonb_build_object(
      'confirmedIn', COALESCE((SELECT confirmed FROM scoped_receivables), 0),
      'pendingIn', COALESCE((SELECT pending FROM scoped_receivables), 0),
      'confirmedOut', COALESCE((SELECT confirmed FROM scoped_payables), 0),
      'pendingOut', COALESCE((SELECT pending FROM scoped_payables), 0)
    ),
    'byStatus', COALESCE((SELECT counts FROM status_breakdown), '{}'::jsonb)
  );
$$;


-- 供应商统计沿用同一订单范围：创建日期 + 同样的 cancelled 口径。
CREATE OR REPLACE FUNCTION public.tenant_supplier_report (
  requested_from date,
  requested_to date,
  requested_include_cancelled boolean DEFAULT FALSE
) RETURNS TABLE (
  supplier_id uuid,
  supplier_name text,
  order_count bigint,
  payable_amount numeric,
  confirmed_amount numeric
) LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  SELECT
    supplier.id,
    supplier.name,
    pg_catalog.count (DISTINCT order_row.id) AS order_count,
    pg_catalog.sum (line.amount) AS payable_amount,
    pg_catalog.sum (line.confirmed_amount) AS confirmed_amount
  FROM public.order_payables AS line
  JOIN public.orders AS order_row ON order_row.id = line.order_id
    AND order_row.organization_id = public.current_organization_id ()
  JOIN public.suppliers AS supplier ON supplier.id = line.supplier_id
    AND supplier.organization_id = public.current_organization_id ()
  WHERE line.organization_id = public.current_organization_id ()
    AND order_row.deleted_at IS NULL
    AND order_row.created_at >= requested_from
    AND order_row.created_at < (requested_to + 1)
    AND (
      requested_include_cancelled
      OR order_row.status <> 'cancelled'
    )
  GROUP BY supplier.id, supplier.name
  ORDER BY pg_catalog.sum (line.amount) DESC;
$$;


REVOKE ALL ON FUNCTION public.tenant_report (date, date, boolean)
FROM
  PUBLIC;


REVOKE ALL ON FUNCTION public.tenant_supplier_report (date, date, boolean)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.tenant_report (date, date, boolean) TO authenticated;


GRANT
EXECUTE ON FUNCTION public.tenant_supplier_report (date, date, boolean) TO authenticated;