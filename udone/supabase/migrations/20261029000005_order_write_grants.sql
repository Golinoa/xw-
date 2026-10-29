-- 补齐订单域的写入授权，并让订单合计始终由明细派生。
--
-- 问题（由空库重放 + 真实角色重放发现，之前只有单元测试覆盖不到）：
-- 1. 三个订单事务函数都是 SECURITY INVOKER，而 `authenticated` 只被授予了
--    orders/order_receivables/order_payables 的 SELECT。于是 PostgREST 以用户 JWT
--    调用 rpc/create_order_with_items 时必然 `permission denied for table orders`，
--    建单接口在生产上是 500，而路由测试用的是 mock 仓储，看不出这一层。
-- 2. `recalculate_order_totals` 是 SECURITY INVOKER，函数体里 UPDATE 的
--    receivable_total / payable_total 恰恰是没有授予的列，同样会被拒。
-- 3. 列级 UPDATE 授权漏了 status、previous_status、customer_id、order_type，
--    状态机与订单编辑也写不进去。
--
-- 修法不是「把表整表授给 authenticated」——那样客户端可以自己写金额列，
-- 「金额只由服务端算」这条不变量就没了。这里按列授权，只开函数真正需要的列：
-- 金额列（receivable_total/payable_total）、订单号、version 仍然不给客户端。
--
-- 另外把 recalculate_order_totals 改成 SECURITY DEFINER：它只写「由明细派生出的
-- 两个合计」，不读也不写别的，被滥用最多是把某个订单的合计按明细重算一遍。
-- 配合明细表上的触发器，合计与明细不可能漂移——无论写入走函数还是直接走表。
ALTER FUNCTION public.recalculate_order_totals (uuid) SECURITY DEFINER;


CREATE OR REPLACE FUNCTION public.sync_order_totals () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  -- DELETE 时 NEW 为 NULL，INSERT 时 OLD 为 NULL，coalesce 覆盖两种情况。
  PERFORM public.recalculate_order_totals (coalesce(NEW.order_id, OLD.order_id));
  RETURN NULL;
END;
$$;


DROP TRIGGER IF EXISTS order_receivables_sync_totals ON public.order_receivables;


CREATE TRIGGER order_receivables_sync_totals
AFTER INSERT OR UPDATE OR DELETE ON public.order_receivables FOR EACH ROW
EXECUTE FUNCTION public.sync_order_totals ();


DROP TRIGGER IF EXISTS order_payables_sync_totals ON public.order_payables;


CREATE TRIGGER order_payables_sync_totals
AFTER INSERT OR UPDATE OR DELETE ON public.order_payables FOR EACH ROW
EXECUTE FUNCTION public.sync_order_totals ();


-- 订单号、金额合计、version 不在授权列表里：它们只能由服务端函数维护。
GRANT insert (
  organization_id,
  order_number,
  order_type,
  status,
  customer_id,
  route_name,
  departure_date,
  return_date,
  adult_count,
  child_count,
  remark,
  created_by
) ON public.orders TO authenticated;


GRANT
UPDATE (customer_id, order_type, status, previous_status) ON public.orders TO authenticated;


GRANT insert (organization_id, order_id, name, amount) ON public.order_receivables TO authenticated;


GRANT delete ON public.order_receivables TO authenticated;


-- 已确认/在途金额不开放写入：收付款确认属于独立的业务流程，
-- 必须走专门的函数（届时再补），不能让编辑订单顺带改掉。
GRANT insert (
  organization_id,
  order_id,
  supplier_id,
  name,
  amount
) ON public.order_payables TO authenticated;


GRANT delete ON public.order_payables TO authenticated;