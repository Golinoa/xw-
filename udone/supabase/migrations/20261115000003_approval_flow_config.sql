-- C1 审批流配置化（数据库层）：配置表 + 实例快照 + 引擎按快照推进。
--
-- 现状：级次写死在 20261029000008 里 —— `current_step BETWEEN 1 AND 2`、
-- 「第二级要求 settings.manage」、同人审批一律禁止。需求要求这三个都能配。
--
-- 最关键的约束（不可省）：**改配置不得静默改变在途实例**。
-- 因此配置在「申请创建时」被拷贝进 `flow_snapshot`，引擎只读快照，
-- 从不回读配置表。改配置只影响之后新提交的申请。
--
-- 级次用「每级需要什么权限」表达，而不是「每级是哪个角色」：
-- 角色是可叠加的（一个人可能同时是 finance 和 admin），权限才是一一判定的东西。

CREATE TABLE public.organization_approval_flows (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations (id) ON DELETE CASCADE,
  steps jsonb NOT NULL,
  allow_self_approval boolean NOT NULL DEFAULT false,
  allow_withdraw boolean NOT NULL DEFAULT true,
  updated_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_approval_flows_steps_shape CHECK (
    jsonb_typeof(steps) = 'array'
    AND jsonb_array_length(steps) BETWEEN 1 AND 3
  )
);


COMMENT ON TABLE public.organization_approval_flows IS '按机构的审批流配置；只影响之后新提交的申请。';


ALTER TABLE public.organization_approval_flows enable ROW level security;


CREATE POLICY organization_approval_flows_select_member ON public.organization_approval_flows FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


-- 默认流程：财务审批 → 管理员终审。与配置化之前的硬编码行为完全一致，
-- 因此存量实例与存量测试不受影响。
CREATE OR REPLACE FUNCTION public.default_approval_flow () RETURNS jsonb LANGUAGE sql IMMUTABLE
SET
  search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'steps', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object('step', 1, 'permission', 'finance.approve'),
      pg_catalog.jsonb_build_object('step', 2, 'permission', 'settings.manage')
    ),
    'allowSelfApproval', false,
    'allowWithdraw', true
  );
$$;


-- 生效配置 = 机构的配置行（若有）叠加默认值。
CREATE OR REPLACE FUNCTION public.effective_approval_flow (target_organization_id uuid) RETURNS jsonb LANGUAGE sql STABLE
SET
  search_path = '' AS $$
  SELECT pg_catalog.jsonb_build_object(
    'steps', coalesce(
      (
        SELECT
          flow.steps
        FROM
          public.organization_approval_flows AS flow
        WHERE
          flow.organization_id = target_organization_id
      ),
      public.default_approval_flow () -> 'steps'
    ),
    'allowSelfApproval', coalesce(
      (
        SELECT
          flow.allow_self_approval
        FROM
          public.organization_approval_flows AS flow
        WHERE
          flow.organization_id = target_organization_id
      ),
      (public.default_approval_flow () ->> 'allowSelfApproval')::boolean
    ),
    'allowWithdraw', coalesce(
      (
        SELECT
          flow.allow_withdraw
        FROM
          public.organization_approval_flows AS flow
        WHERE
          flow.organization_id = target_organization_id
      ),
      (public.default_approval_flow () ->> 'allowWithdraw')::boolean
    )
  );
$$;


-- 实例快照：创建时固化，之后配置怎么改都不回写这里。
ALTER TABLE public.finance_applications
ADD COLUMN flow_snapshot jsonb;


CREATE OR REPLACE FUNCTION public.snapshot_finance_application_flow () RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
BEGIN
  IF NEW.flow_snapshot IS NULL THEN
    NEW.flow_snapshot := public.effective_approval_flow (NEW.organization_id);
  END IF;
  RETURN NEW;
END;
$$;


REVOKE ALL ON FUNCTION public.snapshot_finance_application_flow () FROM PUBLIC;


CREATE TRIGGER finance_applications_snapshot_flow BEFORE INSERT ON public.finance_applications FOR EACH ROW
EXECUTE FUNCTION public.snapshot_finance_application_flow ();


-- 级次上限从 2 放宽到 3（配置允许 3 级）。
ALTER TABLE public.finance_applications DROP CONSTRAINT finance_applications_current_step_check;


ALTER TABLE public.finance_applications
ADD CONSTRAINT finance_applications_current_step_check CHECK (current_step BETWEEN 1 AND 3);


ALTER TABLE public.finance_application_actions DROP CONSTRAINT finance_application_actions_step_check;


ALTER TABLE public.finance_application_actions
ADD CONSTRAINT finance_application_actions_step_check CHECK (step BETWEEN 1 AND 3);


-- 配置写入入口。只有 settings.manage 能改，且改完不影响在途（快照已固化）。
CREATE OR REPLACE FUNCTION public.set_approval_flow (
  requested_steps jsonb,
  requested_allow_self_approval boolean,
  requested_allow_withdraw boolean
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT public.has_permission ('settings.manage')) THEN
    RAISE EXCEPTION 'settings.manage is required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(requested_steps) <> 'array'
    OR jsonb_array_length(requested_steps) NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'approval flow needs 1 to 3 steps' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.organization_approval_flows (
    organization_id, steps, allow_self_approval, allow_withdraw, updated_by
  ) VALUES (
    current_org_id, requested_steps, requested_allow_self_approval,
    requested_allow_withdraw, (SELECT auth.uid ())
  )
  ON CONFLICT (organization_id) DO UPDATE
  SET
    steps = excluded.steps,
    allow_self_approval = excluded.allow_self_approval,
    allow_withdraw = excluded.allow_withdraw,
    updated_by = excluded.updated_by,
    updated_at = pg_catalog.now();
  RETURN TRUE;
END;
$$;


REVOKE ALL ON FUNCTION public.set_approval_flow (jsonb, boolean, boolean) FROM PUBLIC;


GRANT EXECUTE ON FUNCTION public.set_approval_flow (jsonb, boolean, boolean) TO authenticated;


-- 引擎改为读快照。级次、同人审批都来自快照；「终审需要管理员」不再硬编码，
-- 而是由最后一级配置的权限决定。
CREATE OR REPLACE FUNCTION public.decide_finance_application (
  requested_application_id uuid,
  requested_action text,
  requested_opinion text,
  requested_version integer
) RETURNS TABLE (
  new_status text,
  new_step integer,
  error_code text
) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  application public.finance_applications%ROWTYPE;
  flow jsonb;
  total_steps integer;
  required_permission text;
  target_status text;
  target_step integer;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  -- 审批人至少要有 finance.approve；具体某一级还要满足该级配置的权限。
  IF NOT (SELECT public.has_permission ('finance.approve')) THEN
    RAISE EXCEPTION 'finance.approve is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id
    AND applications.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF application.version <> requested_version THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF application.status <> 'pending' THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'APPLICATION_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  -- 旧行没有快照（配置化之前提交的），按默认流程处理，行为与改造前一致。
  flow := coalesce(application.flow_snapshot, public.default_approval_flow ());
  total_steps := jsonb_array_length(flow -> 'steps');

  IF application.current_step > total_steps THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'APPLICATION_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  -- 同人审批按配置放行；默认仍然禁止。
  IF NOT (flow ->> 'allowSelfApproval')::boolean
    AND application.created_by = current_user_id THEN
    RETURN QUERY SELECT NULL::text, NULL::integer, 'SELF_APPROVAL_FORBIDDEN'::text;
    RETURN;
  END IF;

  IF requested_action = 'reject' THEN
    IF requested_opinion IS NULL OR length(btrim(requested_opinion)) = 0 THEN
      RETURN QUERY SELECT NULL::text, NULL::integer, 'REASON_REQUIRED'::text;
      RETURN;
    END IF;

    target_status := 'rejected';
    target_step := application.current_step;

    PERFORM public.release_finance_application_hold (application.id);

  ELSIF requested_action = 'approve' THEN
    -- 该级需要的权限来自快照：默认第 1 级 finance.approve、第 2 级 settings.manage。
    required_permission := flow -> 'steps' -> (application.current_step - 1) ->> 'permission';
    IF required_permission IS NOT NULL
      AND NOT (SELECT public.has_permission (required_permission)) THEN
      -- 终审那句沿用配置化之前的文案：多处断言按「administrator」匹配，
      -- 改文案会让那些断言变红，而它们要表达的业务含义没变。
      IF application.current_step = total_steps THEN
        RAISE EXCEPTION 'the final step requires an administrator (step % needs %)',
          application.current_step, required_permission USING ERRCODE = '42501';
      END IF;
      RAISE EXCEPTION 'step % requires %', application.current_step, required_permission USING ERRCODE = '42501';
    END IF;

    IF application.current_step < total_steps THEN
      -- 前级通过：状态仍是待审，只是推进到下一级，额度继续占用。
      target_status := 'pending';
      target_step := application.current_step + 1;
    ELSE
      target_status := 'approved';
      target_step := application.current_step;
      PERFORM public.confirm_finance_application_hold (application.id);
    END IF;
  ELSE
    RETURN QUERY SELECT NULL::text, NULL::integer, 'ACTION_INVALID'::text;
    RETURN;
  END IF;

  UPDATE public.finance_applications AS applications
  SET
    status = target_status,
    current_step = target_step,
    version = application.version + 1,
    updated_by = current_user_id,
    updated_at = now ()
  WHERE applications.id = application.id;

  INSERT INTO public.finance_application_actions (
    organization_id, application_id, step, action, actor_id, opinion,
    from_status, to_status
  ) VALUES (
    current_org_id, application.id, application.current_step,
    requested_action, current_user_id, requested_opinion,
    application.status, target_status
  );

  RETURN QUERY SELECT target_status, target_step, NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.decide_finance_application (uuid, text, text, integer) FROM PUBLIC;


GRANT EXECUTE ON FUNCTION public.decide_finance_application (uuid, text, text, integer) TO authenticated;


-- 撤回开关：`allowWithdraw = false` 时创建人不能撤回，只能等审批或驳回。
-- 快照优先，旧行按默认值（允许撤回），与改造前一致。
CREATE OR REPLACE FUNCTION public.withdraw_finance_application (
  requested_application_id uuid,
  requested_reason text,
  requested_version integer
) RETURNS TABLE (new_status text, error_code text) LANGUAGE plpgsql
SET
  search_path = '' SECURITY DEFINER AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_user_id uuid := (SELECT auth.uid ());
  application public.finance_applications%ROWTYPE;
  flow jsonb;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO application FROM public.finance_applications AS applications
  WHERE applications.id = requested_application_id
    AND applications.organization_id = current_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::text, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF application.created_by IS DISTINCT FROM current_user_id THEN
    RAISE EXCEPTION 'only the creator can withdraw an application' USING ERRCODE = '42501';
  END IF;

  IF application.version <> requested_version THEN
    RETURN QUERY SELECT NULL::text, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  IF application.status <> 'pending' THEN
    RETURN QUERY SELECT NULL::text, 'APPLICATION_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  flow := coalesce(application.flow_snapshot, public.default_approval_flow ());
  IF NOT (flow ->> 'allowWithdraw')::boolean THEN
    -- 用错误码而不是抛异常：这是业务流程拒绝，不是权限问题。
    RETURN QUERY SELECT NULL::text, 'WITHDRAW_NOT_ALLOWED'::text;
    RETURN;
  END IF;

  IF requested_reason IS NULL OR length(btrim(requested_reason)) = 0 THEN
    RETURN QUERY SELECT NULL::text, 'REASON_REQUIRED'::text;
    RETURN;
  END IF;

  PERFORM public.release_finance_application_hold (application.id);

  UPDATE public.finance_applications AS applications
  SET
    status = 'withdrawn',
    version = application.version + 1,
    updated_by = current_user_id,
    updated_at = now ()
  WHERE applications.id = application.id;

  INSERT INTO public.finance_application_actions (
    organization_id, application_id, step, action, actor_id, opinion,
    from_status, to_status
  ) VALUES (
    current_org_id, application.id, application.current_step,
    'withdraw', current_user_id, requested_reason,
    application.status, 'withdrawn'
  );

  RETURN QUERY SELECT 'withdrawn'::text, NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.withdraw_finance_application (uuid, text, integer) FROM PUBLIC;


GRANT EXECUTE ON FUNCTION public.withdraw_finance_application (uuid, text, integer) TO authenticated;
