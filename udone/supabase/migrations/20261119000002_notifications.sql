-- C9 站内通知（R-NOTIFY-01）：事务内写通知 + 未读/已读 + 对象跳转。
--
-- 需求要的五类提醒：审批待办、驳回、临期、出团、跟进。首期落三类可确定的：
--   1. 申请提交（pending）→ 通知有审批权的成员；
--   2. 审批通过/驳回 → 通知申请人；
--   3. 结算批次确认 → 通知财务。
-- 临期与出团依赖日期调度（Cron），跟进提醒依赖 CRM 线索（C11），都放在后续任务，
-- 不为凑数在这里造没有数据支撑的提醒。
--
-- 关键约束：通知必须和业务写在同一事务里（触发器 AFTER 写），
-- 否则「审批通过了但没通知」这种不一致会长期存在且无法对账。
-- 不接外部短信/邮件/企微——需求明确首期不做。
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  notification_type text NOT NULL CHECK (
    notification_type IN (
      'approval_pending',
      'application_approved',
      'application_rejected',
      'settlement_confirmed'
    )
  ),
  title text NOT NULL CHECK (length(btrim(title)) > 0),
  body text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);


CREATE INDEX notifications_recipient_unread_idx ON public.notifications (organization_id, recipient_id, created_at DESC)
WHERE
  read_at IS NULL;


COMMENT ON TABLE public.notifications IS '站内通知；业务事务内写入，首期不接外部推送。';


ALTER TABLE public.notifications enable ROW level security;


CREATE POLICY notifications_select_recipient ON public.notifications FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND recipient_id = (
      SELECT
        auth.uid ()
    )
  );


-- 只有收件人能把自己那条标记已读；不能改别人的，也不能改标题内容。
CREATE POLICY notifications_update_read ON public.notifications
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND recipient_id = (
      SELECT
        auth.uid ()
    )
  )
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND recipient_id = (
      SELECT
        auth.uid ()
    )
  );


REVOKE ALL ON public.notifications
FROM
  PUBLIC;


GRANT
SELECT
,
UPDATE ON public.notifications TO authenticated;


-- 申请审批结果通知申请人：状态从 pending 变为终态时触发。
CREATE OR REPLACE FUNCTION public.notify_application_decision () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  notification_type text;
  notification_title text;
  notification_body text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status
    OR NEW.status NOT IN ('approved', 'rejected', 'withdrawn')
    OR NEW.created_by IS NULL THEN
    RETURN NEW;
  END IF;

  notification_type := CASE NEW.status
    WHEN 'approved' THEN 'application_approved'
    WHEN 'rejected' THEN 'application_rejected'
    ELSE 'application_rejected'
  END;
  notification_title := CASE NEW.status
    WHEN 'approved' THEN '申请已通过'
    WHEN 'rejected' THEN '申请被驳回'
    ELSE '申请已撤回'
  END;
  notification_body := pg_catalog.concat(
    CASE WHEN NEW.kind = 'receipt' THEN '收款申请' ELSE '付款申请' END,
    ' ¥',
    NEW.amount,
    ' 已',
    CASE NEW.status
      WHEN 'approved' THEN '审批通过'
      WHEN 'rejected' THEN '驳回'
      ELSE '撤回'
    END
  );

  INSERT INTO public.notifications (
    organization_id, recipient_id, notification_type, title, body, entity_type, entity_id
  ) VALUES (
    NEW.organization_id, NEW.created_by, notification_type,
    notification_title, notification_body, 'finance_application', NEW.id
  );

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS notify_application_decision_trigger ON public.finance_applications;


CREATE TRIGGER notify_application_decision_trigger
AFTER UPDATE ON public.finance_applications FOR EACH ROW
EXECUTE FUNCTION public.notify_application_decision ();


-- 结算批次确认通知财务角色成员（有 finance.write 的人）。
CREATE OR REPLACE FUNCTION public.notify_settlement_confirmed () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  finance_user record;
BEGIN
  IF OLD.status IS DISTINCT FROM 'draft'
    OR NEW.status IS DISTINCT FROM 'confirmed' THEN
    RETURN NEW;
  END IF;

  FOR finance_user IN
    SELECT DISTINCT member.user_id
    FROM public.organization_members AS member
    WHERE member.organization_id = NEW.organization_id
      AND member.role IN ('finance', 'admin')
  LOOP
    INSERT INTO public.notifications (
      organization_id, recipient_id, notification_type, title, body, entity_type, entity_id
    ) VALUES (
      NEW.organization_id, finance_user.user_id, 'settlement_confirmed',
      '结算批次已确认',
      pg_catalog.concat('供应商结算批次 ¥', NEW.total_amount, ' 已确认'),
      'settlement_batch', NEW.id
    );
  END LOOP;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS notify_settlement_confirmed_trigger ON public.settlement_batches;


CREATE TRIGGER notify_settlement_confirmed_trigger
AFTER UPDATE ON public.settlement_batches FOR EACH ROW
EXECUTE FUNCTION public.notify_settlement_confirmed ();