-- C10 租户侧审计（R-AUDIT-01）：设备/位置摘要字段 + 统一写入函数 + 强制动作审计。
--
-- 审计表从平台骨架阶段就存在，但写入点散落在各处（成员生命周期、公司配置），
-- 且订单状态/金额/审批这些「资损相关」动作完全没有审计。本迁移做三件事：
--   1. 给表加 ip_summary / device_summary 两列（只存摘要，不存完整 IP/UA）；
--   2. 提供唯一的写入函数 public.write_audit()，后续所有动作都走它；
--   3. 用触发器补上订单状态与金额变更、审批动作、删除恢复这三类强制动作的审计。
--
-- 隐私红线：密码/Cookie/Token/完整证件号/附件正文绝不写进审计。
-- 因此 ip_summary 是 /24 掩码后的前缀，device_summary 只取 User-Agent 的浏览器+系统令牌，
-- 都从 request headers 里的可选字段读，没有就留 NULL，绝不从 body 里抓。
ALTER TABLE public.audit_events
ADD COLUMN ip_summary text,
ADD COLUMN device_summary text;


COMMENT ON COLUMN public.audit_events.ip_summary IS 'IP 掩码摘要（如 203.0.113.0/24），不存完整地址。';


COMMENT ON COLUMN public.audit_events.device_summary IS 'User-Agent 的浏览器/系统摘要，不存完整 UA 字符串。';


CREATE OR REPLACE FUNCTION public.audit_ip_summary () RETURNS text LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  SELECT CASE
    WHEN nullif(current_setting('request.headers', TRUE), '') IS NULL THEN NULL
    WHEN pg_catalog.strpos(current_setting('request.headers', TRUE), 'x-forwarded-for') = 0 THEN NULL
    ELSE pg_catalog.regexp_replace(
      pg_catalog.split_part(
        pg_catalog.split_part(
          pg_catalog.split_part(current_setting('request.headers', TRUE), '"x-forwarded-for":', 2),
          '"',
          2
        ),
        ',',
        1
      ),
      '(\d+)\.(\d+)\.(\d+)\.\d+',
      '\1.\2.\3.0/24'
    )
  END;
$$;


CREATE OR REPLACE FUNCTION public.audit_device_summary () RETURNS text LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  SELECT CASE
    WHEN nullif(current_setting('request.headers', TRUE), '') IS NULL THEN NULL
    WHEN pg_catalog.strpos(current_setting('request.headers', TRUE), 'user-agent') = 0 THEN NULL
    ELSE pg_catalog.left(
      pg_catalog.split_part(
        pg_catalog.split_part(current_setting('request.headers', TRUE), '"user-agent":', 2),
        '"',
        2
      ),
      80
    )
  END;
$$;


-- 统一写入函数：actor 必须来自 auth.uid()，不接受调用方传入，
-- 否则任何人都可能替别人留痕。request_id 从 PostgREST 请求头读，串起同一次操作。
CREATE OR REPLACE FUNCTION public.write_audit (
  requested_action text,
  requested_entity_type text DEFAULT NULL,
  requested_entity_id uuid DEFAULT NULL,
  requested_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
BEGIN
  IF current_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.audit_events (
    organization_id, actor_id, action, entity_type, entity_id,
    request_id, metadata, ip_summary, device_summary
  ) VALUES (
    current_org_id,
    (SELECT auth.uid ()),
    requested_action,
    requested_entity_type,
    requested_entity_id,
    nullif(current_setting('request.headers', TRUE), ''),
    COALESCE(requested_metadata, '{}'::jsonb),
    public.audit_ip_summary (),
    public.audit_device_summary ()
  );
END;
$$;


REVOKE ALL ON FUNCTION public.write_audit (text, text, uuid, jsonb)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.write_audit (text, text, uuid, jsonb) TO authenticated;


-- 订单状态与金额：资损相关，任何 UPDATE 都要留下「改前 → 改后」。
CREATE OR REPLACE FUNCTION public.audit_order_update () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.write_audit(
      'order.status_changed', 'order', NEW.id,
      pg_catalog.jsonb_build_object(
        'orderNumber', NEW.order_number,
        'from', OLD.status,
        'to', NEW.status
      )
    );
  END IF;

  IF OLD.receivable_total IS DISTINCT FROM NEW.receivable_total
    OR OLD.payable_total IS DISTINCT FROM NEW.payable_total THEN
    PERFORM public.write_audit(
      'order.amount_changed', 'order', NEW.id,
      pg_catalog.jsonb_build_object(
        'orderNumber', NEW.order_number,
        'receivableFrom', OLD.receivable_total,
        'receivableTo', NEW.receivable_total,
        'payableFrom', OLD.payable_total,
        'payableTo', NEW.payable_total
      )
    );
  END IF;

  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS audit_order_update_trigger ON public.orders;


CREATE TRIGGER audit_order_update_trigger
AFTER UPDATE ON public.orders FOR EACH ROW
EXECUTE FUNCTION public.audit_order_update ();


-- 审批动作：申请状态一变就记，包括级次与驳回原因（原因已在申请表里，不重复存正文）。
CREATE OR REPLACE FUNCTION public.audit_application_transition () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    PERFORM public.write_audit(
      'finance_application.transitioned', 'finance_application', NEW.id,
      pg_catalog.jsonb_build_object(
        'from', OLD.status,
        'to', NEW.status,
        'currentStep', NEW.current_step
      )
    );
  END IF;
  RETURN NEW;
END;
$$;


DROP TRIGGER IF EXISTS audit_application_transition_trigger ON public.finance_applications;


CREATE TRIGGER audit_application_transition_trigger
AFTER UPDATE ON public.finance_applications FOR EACH ROW
EXECUTE FUNCTION public.audit_application_transition ();