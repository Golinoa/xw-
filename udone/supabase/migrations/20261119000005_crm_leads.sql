-- C11 CRM 线索与公海（R-CRM-01/02）。
--
-- 口径来自 Docs/REQUIREMENTS.md §4：
--   · 阶段：新线索 / 需求沟通 / 报价中 / 方案确认 / 已成单 / 已放弃
--   · 跟进与阶段变更追加历史事件，不覆盖旧值
--   · 公海：无有效跟进满 7 个自然日进入回收；认领/分配用版本条件防并发
--   · 转客户/转订单必须幂等，重复客户提示并允许关联既有客户
--
-- 首期只落线索 + 公海 + 幂等转客户。转订单需要订单创建函数配合，
-- 放在线索转换之后另做；「转客户」已完成才算闭环的前半段。
CREATE TYPE public.lead_stage AS ENUM(
  'new',
  'contacting',
  'quoting',
  'proposal',
  'won',
  'lost'
);


CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  phone text,
  wechat text,
  email text,
  source text,
  destination text,
  departure_city text,
  trip_type text,
  intent_level text,
  expected_date date,
  budget_min numeric(14, 2),
  budget_max numeric(14, 2),
  adult_count integer NOT NULL DEFAULT 0 CHECK (adult_count >= 0),
  child_count integer NOT NULL DEFAULT 0 CHECK (child_count >= 0),
  remark text,
  stage public.lead_stage NOT NULL DEFAULT 'new',
  owner_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  next_follow_up_at timestamptz,
  last_follow_up_at timestamptz,
  converted_customer_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT leads_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT leads_budget_order CHECK (
    budget_min IS NULL
    OR budget_max IS NULL
    OR budget_max >= budget_min
  )
);


CREATE TABLE public.lead_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE CASCADE,
  lead_id uuid NOT NULL REFERENCES public.leads (id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (
    event_type IN (
      'created',
      'stage_changed',
      'follow_up',
      'claimed',
      'assigned',
      'recycled',
      'converted'
    )
  ),
  detail text,
  actor_id uuid REFERENCES auth.users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_events_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT lead_events_lead_tenant_fk FOREIGN KEY (lead_id, organization_id) REFERENCES public.leads (id, organization_id) ON DELETE CASCADE
);


CREATE INDEX leads_org_owner_idx ON public.leads (organization_id, owner_id)
WHERE
  converted_customer_id IS NULL;


CREATE INDEX leads_org_stage_idx ON public.leads (organization_id, stage, created_at DESC);


CREATE INDEX lead_events_lead_idx ON public.lead_events (organization_id, lead_id, created_at DESC);


COMMENT ON TABLE public.leads IS 'CRM 线索；owner_id 为空即进入公海。';


COMMENT ON TABLE public.lead_events IS '线索跟进与阶段变更的完整时间线，只追加不修改。';


ALTER TABLE public.leads enable ROW level security;


ALTER TABLE public.lead_events enable ROW level security;


CREATE POLICY leads_select_member ON public.leads FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


CREATE POLICY lead_events_select_member ON public.lead_events FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
  );


-- 线索表与事件表都不给 authenticated 直接写：所有变更走下面的 RPC，
-- 否则事件时间线会被绕过，「跟进历史」随时可能缺一段。
REVOKE ALL ON public.leads
FROM
  PUBLIC;


REVOKE ALL ON public.lead_events
FROM
  PUBLIC;


GRANT
SELECT
  ON public.leads TO authenticated;


GRANT
SELECT
  ON public.lead_events TO authenticated;