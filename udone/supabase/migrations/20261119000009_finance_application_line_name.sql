-- 审批申请的明细名称快照（B1「脱钩」方案的收尾）
--
-- 背景：`20261115000001` 把「删行」改成脱钩——申请保留 `order_id`，把
-- `receivable_id` / `payable_id` 置空。这样申请不会被级联删掉，但**费用名称丢了**，
-- API 只能显示「（明细已删除）」。财务事后核账时看不出这笔钱是什么费用。
--
-- 做法：写入时快照名称。用触发器而不是改 `create_finance_application` 的函数体——
-- 后者要把整个函数复制一遍，将来任何字段调整都得同步两处。

ALTER TABLE public.finance_applications
ADD COLUMN line_name text;


-- 存量数据回填：还挂着明细的直接取；已脱钩的取不到，保持 NULL（不编造）。
UPDATE public.finance_applications AS application
SET
  line_name = COALESCE(
    (
      SELECT
        line.name
      FROM
        public.order_receivables AS line
      WHERE
        line.id = application.receivable_id
    ),
    (
      SELECT
        line.name
      FROM
        public.order_payables AS line
      WHERE
        line.id = application.payable_id
    )
  )
WHERE
  application.line_name IS NULL;


CREATE OR REPLACE FUNCTION public.snapshot_finance_application_line_name () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  IF NEW.kind = 'receipt' AND NEW.receivable_id IS NOT NULL THEN
    SELECT line.name INTO NEW.line_name
    FROM public.order_receivables AS line
    WHERE line.id = NEW.receivable_id;
  ELSIF NEW.kind = 'payment' AND NEW.payable_id IS NOT NULL THEN
    SELECT line.name INTO NEW.line_name
    FROM public.order_payables AS line
    WHERE line.id = NEW.payable_id;
  END IF;
  RETURN NEW;
END;
$$;


CREATE TRIGGER finance_applications_line_name_snapshot
BEFORE INSERT ON public.finance_applications FOR EACH ROW
EXECUTE FUNCTION public.snapshot_finance_application_line_name ();
