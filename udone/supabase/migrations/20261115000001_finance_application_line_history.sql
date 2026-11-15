-- B1：审批轨迹不随明细行删除消失（R-APPROVAL-02 的审计前提）。
--
-- 缺口：order_receivables / order_payables 被删时，finance_applications 的外键
-- CASCADE 会一起把申请删掉，finance_application_actions 随即跟着消失。
-- 被驳回/已撤回的申请不占额度（confirmed = 0 且 pending = 0），
-- update_order_with_items 的删行守卫（LINE_HAS_PAYMENTS）拦不住，
-- 于是「这行曾经申请过什么、谁批的、为什么驳回」这些审计材料会被一次订单编辑抹掉。
--
-- 为什么不选 ON DELETE RESTRICT：
-- 终态申请没有任何可处置动作（驳回/撤回都是终点），改成 RESTRICT 等于让
-- 「曾经申请过」的明细行永远删不掉 —— 用户卡死且无出路，比现状更糟。
--
-- 采取「脱钩」：删行前把申请上的行引用置空，申请与其轨迹留下。
-- order_id 不变，仍能定位到哪一单；明细名称由 API 侧兜底成「（明细已删除）」
-- （finance-application-service.ts 的 toItem 已实现），因此不需要在申请上做名称快照。
--
-- 副作用的口径：脱钩后的申请两者皆空，CHECK 由「必须有一个且与 kind 对应」
-- 放宽为「至多一个，非空时必须与 kind 对应」。

-- 1) 放宽行引用约束
ALTER TABLE public.finance_applications DROP CONSTRAINT finance_applications_line_exclusive;


ALTER TABLE public.finance_applications
ADD CONSTRAINT finance_applications_line_exclusive CHECK (
  (receivable_id IS NULL OR kind = 'receipt')
  AND (payable_id IS NULL OR kind = 'payment')
  AND (receivable_id IS NULL OR payable_id IS NULL)
);


-- 2) 脱钩函数
-- SECURITY DEFINER：删行的操作员不一定有 UPDATE 申请的权限，
-- 而脱钩是删除动作的副作用，不能因为权限边界而退化成级联删除。
-- 触发器函数不需要任何人可执行，因此收回 PUBLIC 的 EXECUTE。
CREATE OR REPLACE FUNCTION public.detach_finance_applications_from_line () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'order_receivables' THEN
    UPDATE public.finance_applications AS application
    SET
      receivable_id = NULL,
      updated_at = pg_catalog.now()
    WHERE
      application.receivable_id = OLD.id;
  ELSE
    UPDATE public.finance_applications AS application
    SET
      payable_id = NULL,
      updated_at = pg_catalog.now()
    WHERE
      application.payable_id = OLD.id;
  END IF;
  RETURN OLD;
END;
$$;


REVOKE ALL ON FUNCTION public.detach_finance_applications_from_line () FROM PUBLIC;


CREATE TRIGGER order_receivables_detach_applications BEFORE DELETE ON public.order_receivables FOR EACH ROW
EXECUTE FUNCTION public.detach_finance_applications_from_line ();


CREATE TRIGGER order_payables_detach_applications BEFORE DELETE ON public.order_payables FOR EACH ROW
EXECUTE FUNCTION public.detach_finance_applications_from_line ();


-- 3) 外键检查与脱钩更新都按单列定位，补索引免得每次删行做顺序扫描
CREATE INDEX finance_applications_receivable_idx ON public.finance_applications (receivable_id)
WHERE
  receivable_id IS NOT NULL;


CREATE INDEX finance_applications_payable_idx ON public.finance_applications (payable_id)
WHERE
  payable_id IS NOT NULL;
