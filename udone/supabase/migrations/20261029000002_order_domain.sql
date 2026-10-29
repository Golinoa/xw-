-- 订单域（R-ORDER-01/02/03、REQUIREMENTS.md §17、§20.1）。
--
-- 关键约束：
-- 1. 金额一律 numeric(14,2)，禁止浮点；合计与利润由服务端重算，不接受前端总计。
-- 2. 订单号由序列生成，租户内唯一（全局唯一自然满足）；不按租户重置计数，
--    因为「按租户计数」在并发下需要额外锁，收益只是序号更短。
-- 3. 状态只能通过具名动作迁移，函数内用 CASE 列出合法迁移表，
--    非法迁移返回 error_code 而不是抛异常——API 需要把它映射成稳定的业务错误码。
-- 4. 创建订单必须在一个事务里完成「订单 + 应收行 + 应付行 + 合计」，
--    否则中途失败会留下金额为 0 的空订单。
CREATE TABLE public.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  type text NOT NULL DEFAULT 'other' CHECK (
    type IN (
      'hotel',
      'transport',
      'restaurant',
      'ticket',
      'other'
    )
  ),
  contact_name text,
  phone text,
  settlement text NOT NULL DEFAULT 'per_trip' CHECK (settlement IN ('monthly', 'per_trip')),
  is_active boolean NOT NULL DEFAULT TRUE,
  remark text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT suppliers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT suppliers_name_key UNIQUE (organization_id, name)
);


CREATE INDEX suppliers_organization_idx ON public.suppliers (organization_id, is_active);


CREATE SEQUENCE public.order_number_seq START 1;


CREATE TABLE public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  order_number text NOT NULL,
  order_type text NOT NULL CHECK (order_type IN ('active', 'booking')),
  status text NOT NULL CHECK (
    status IN ('booking', 'active', 'completed', 'cancelled')
  ),
  previous_status text CHECK (
    previous_status IS NULL
    OR previous_status IN ('booking', 'active', 'completed')
  ),
  customer_id uuid NOT NULL,
  route_name text,
  departure_date date,
  return_date date,
  adult_count integer NOT NULL DEFAULT 0 CHECK (adult_count >= 0),
  child_count integer NOT NULL DEFAULT 0 CHECK (child_count >= 0),
  person_count integer GENERATED ALWAYS AS (adult_count + child_count) STORED,
  receivable_total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (receivable_total >= 0),
  payable_total numeric(14, 2) NOT NULL DEFAULT 0 CHECK (payable_total >= 0),
  profit numeric(14, 2) GENERATED ALWAYS AS (receivable_total - payable_total) STORED,
  status_reason text,
  remark text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  CONSTRAINT orders_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT orders_number_key UNIQUE (organization_id, order_number),
  CONSTRAINT orders_customer_tenant_fk FOREIGN KEY (customer_id, organization_id) REFERENCES public.customers (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT orders_date_order CHECK (
    return_date IS NULL
    OR departure_date IS NULL
    OR return_date >= departure_date
  )
);


CREATE INDEX orders_organization_created_idx ON public.orders (organization_id, created_at DESC)
WHERE
  deleted_at IS NULL;


CREATE INDEX orders_organization_status_idx ON public.orders (organization_id, status)
WHERE
  deleted_at IS NULL;


CREATE INDEX orders_organization_customer_idx ON public.orders (organization_id, customer_id)
WHERE
  deleted_at IS NULL;


CREATE INDEX orders_organization_departure_idx ON public.orders (organization_id, departure_date)
WHERE
  deleted_at IS NULL;


CREATE TABLE public.order_receivables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  confirmed_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (confirmed_amount >= 0),
  pending_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (pending_amount >= 0),
  available_amount numeric(14, 2) GENERATED ALWAYS AS (amount - confirmed_amount - pending_amount) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_receivables_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES public.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT order_receivables_capacity CHECK (confirmed_amount + pending_amount <= amount)
);


CREATE INDEX order_receivables_order_idx ON public.order_receivables (order_id);


CREATE TABLE public.order_payables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
  confirmed_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (confirmed_amount >= 0),
  pending_amount numeric(14, 2) NOT NULL DEFAULT 0 CHECK (pending_amount >= 0),
  available_amount numeric(14, 2) GENERATED ALWAYS AS (amount - confirmed_amount - pending_amount) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT order_payables_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES public.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT order_payables_supplier_tenant_fk FOREIGN KEY (supplier_id, organization_id) REFERENCES public.suppliers (id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT order_payables_capacity CHECK (confirmed_amount + pending_amount <= amount)
);


CREATE INDEX order_payables_order_idx ON public.order_payables (order_id);


CREATE INDEX order_payables_supplier_idx ON public.order_payables (organization_id, supplier_id);


INSERT INTO
  public.organization_role_permissions (role, permission)
VALUES
  ('admin', 'order.read'),
  ('admin', 'order.write'),
  ('admin', 'supplier.read'),
  ('admin', 'supplier.write'),
  ('operator', 'order.read'),
  ('operator', 'order.write'),
  ('operator', 'supplier.read'),
  ('operator', 'supplier.write'),
  ('finance', 'order.read'),
  ('finance', 'supplier.read')
ON CONFLICT (role, permission) DO NOTHING;


ALTER TABLE public.suppliers enable ROW level security;


ALTER TABLE public.orders enable ROW level security;


ALTER TABLE public.order_receivables enable ROW level security;


ALTER TABLE public.order_payables enable ROW level security;


REVOKE ALL ON public.suppliers,
public.orders,
public.order_receivables,
public.order_payables
FROM
  public,
  anon,
  authenticated;


GRANT
SELECT
  ON public.orders TO authenticated;


-- 金额列与订单号由服务端函数维护，不授予客户端直接写，避免绕过重算。
GRANT
UPDATE (
  route_name,
  departure_date,
  return_date,
  adult_count,
  child_count,
  remark,
  status_reason,
  updated_by,
  updated_at,
  deleted_at,
  deleted_by,
  version
) ON public.orders TO authenticated;


GRANT
SELECT
  ON public.order_receivables,
  public.order_payables TO authenticated;


GRANT
SELECT
,
  insert,
UPDATE ON public.suppliers TO authenticated;


GRANT ALL ON public.suppliers,
public.orders,
public.order_receivables,
public.order_payables TO service_role;


GRANT USAGE ON SEQUENCE public.order_number_seq TO authenticated,
service_role;


CREATE POLICY suppliers_select_reader ON public.suppliers FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('supplier.read')
    )
  );


CREATE POLICY suppliers_insert_writer ON public.suppliers FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('supplier.write')
    )
  );


CREATE POLICY suppliers_update_writer ON public.suppliers
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('supplier.write')
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
        public.has_permission ('supplier.write')
    )
  );


CREATE POLICY orders_select_scoped ON public.orders FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.read')
    )
    AND (
      (
        SELECT
          public.current_data_scope ()
      ) = 'all'
      OR created_by = (
        SELECT
          auth.uid ()
      )
    )
  );


CREATE POLICY orders_insert_writer ON public.orders FOR insert TO authenticated
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
    AND created_by = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY orders_update_writer ON public.orders
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
    AND (
      (
        SELECT
          public.current_data_scope ()
      ) = 'all'
      OR created_by = (
        SELECT
          auth.uid ()
      )
    )
    AND deleted_at IS NULL
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
  );


CREATE POLICY order_receivables_select_reader ON public.order_receivables FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.read')
    )
  );


CREATE POLICY order_receivables_write_writer ON public.order_receivables FOR ALL TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('order.write')
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
  );


CREATE POLICY order_payables_select_reader ON public.order_payables FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('order.read')
    )
  );


CREATE POLICY order_payables_write_writer ON public.order_payables FOR ALL TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('order.write')
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
  );


-- 合计重算：只信任明细行，绝不使用请求里的总计。
CREATE OR REPLACE FUNCTION public.recalculate_order_totals (target_order_id uuid) RETURNS void LANGUAGE sql
SET
  search_path = '' AS $$
  UPDATE public.orders AS orders
  SET
    receivable_total = coalesce((
      SELECT sum(line.amount) FROM public.order_receivables AS line WHERE line.order_id = orders.id
    ), 0),
    payable_total = coalesce((
      SELECT sum(line.amount) FROM public.order_payables AS line WHERE line.order_id = orders.id
    ), 0)
  WHERE orders.id = target_order_id;
$$;


CREATE OR REPLACE FUNCTION public.create_order_with_items (
  requested_customer_id uuid,
  requested_order_type text,
  requested_receivables jsonb DEFAULT '[]'::jsonb,
  requested_payables jsonb DEFAULT '[]'::jsonb,
  requested_route_name text DEFAULT NULL,
  requested_departure_date date DEFAULT NULL,
  requested_return_date date DEFAULT NULL,
  requested_adult_count integer DEFAULT 0,
  requested_child_count integer DEFAULT 0,
  requested_remark text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  new_order_id uuid;
  generated_number text;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  -- 客户必须属于当前组织且未删除；复合外键会兜底，但这里给出可理解的失败原因。
  IF NOT EXISTS (
    SELECT 1 FROM public.customers AS customer
    WHERE customer.id = requested_customer_id
      AND customer.organization_id = current_org_id
      AND customer.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'customer_not_available' USING ERRCODE = '23503';
  END IF;

  generated_number := 'SO-' || to_char(now() AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD') || '-'
    || lpad(nextval('public.order_number_seq')::text, 6, '0');

  INSERT INTO public.orders (
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
  )
VALUES
  (
    current_org_id,
    generated_number,
    requested_order_type,
    -- 预订单从 booking 起步，正式订单直接 active。
    CASE WHEN requested_order_type = 'booking' THEN 'booking' ELSE 'active' END,
    requested_customer_id,
    requested_route_name,
    requested_departure_date,
    requested_return_date,
    coalesce(requested_adult_count, 0),
    coalesce(requested_child_count, 0),
    requested_remark,
    (SELECT auth.uid ())
  )
RETURNING
  id INTO new_order_id;

  INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
  SELECT
    current_org_id,
    new_order_id,
    item ->> 'name',
    (item ->> 'amount')::numeric(14, 2)
  FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item;

  INSERT INTO public.order_payables (organization_id, order_id, supplier_id, name, amount)
  SELECT
    current_org_id,
    new_order_id,
    (item ->> 'supplierId')::uuid,
    item ->> 'name',
    (item ->> 'amount')::numeric(14, 2)
  FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item;

  PERFORM public.recalculate_order_totals (new_order_id);

  RETURN new_order_id;
END;
$$;


CREATE OR REPLACE FUNCTION public.update_order_with_items (
  requested_order_id uuid,
  requested_version integer,
  requested_customer_id uuid,
  requested_order_type text,
  requested_receivables jsonb,
  requested_payables jsonb,
  requested_route_name text DEFAULT NULL,
  requested_departure_date date DEFAULT NULL,
  requested_return_date date DEFAULT NULL,
  requested_adult_count integer DEFAULT 0,
  requested_child_count integer DEFAULT 0,
  requested_remark text DEFAULT NULL
) RETURNS TABLE (result_order_id uuid, error_code text) LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_order public.orders%ROWTYPE;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_order FROM public.orders AS orders
  WHERE orders.id = requested_order_id
    AND orders.organization_id = current_org_id
    AND orders.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF current_order.version <> requested_version THEN
    RETURN QUERY SELECT NULL::uuid, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  -- 锁团后编辑受限：必须先解锁再改（R-ORDER-02）。
  IF current_order.status = 'completed' THEN
    RETURN QUERY SELECT NULL::uuid, 'ORDER_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  IF current_order.status = 'cancelled' THEN
    RETURN QUERY SELECT NULL::uuid, 'ORDER_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  UPDATE public.orders AS orders
  SET
    customer_id = requested_customer_id,
    order_type = requested_order_type,
    route_name = requested_route_name,
    departure_date = requested_departure_date,
    return_date = requested_return_date,
    adult_count = coalesce(requested_adult_count, 0),
    child_count = coalesce(requested_child_count, 0),
    remark = requested_remark,
    version = current_order.version + 1,
    updated_by = (SELECT auth.uid ()),
    updated_at = now()
  WHERE orders.id = requested_order_id;

  -- 金额行整体替换：这是重新定价，不是增量合并。
  DELETE FROM public.order_receivables AS line WHERE line.order_id = requested_order_id;
  DELETE FROM public.order_payables AS line WHERE line.order_id = requested_order_id;

  INSERT INTO public.order_receivables (organization_id, order_id, name, amount)
  SELECT
    current_org_id,
    requested_order_id,
    item ->> 'name',
    (item ->> 'amount')::numeric(14, 2)
  FROM jsonb_array_elements(coalesce(requested_receivables, '[]'::jsonb)) AS item;

  INSERT INTO public.order_payables (organization_id, order_id, supplier_id, name, amount)
  SELECT
    current_org_id,
    requested_order_id,
    (item ->> 'supplierId')::uuid,
    item ->> 'name',
    (item ->> 'amount')::numeric(14, 2)
  FROM jsonb_array_elements(coalesce(requested_payables, '[]'::jsonb)) AS item;

  PERFORM public.recalculate_order_totals (requested_order_id);

  RETURN QUERY SELECT requested_order_id, NULL::text;
END;
$$;


CREATE OR REPLACE FUNCTION public.transition_order_status (
  requested_order_id uuid,
  requested_action text,
  requested_version integer,
  requested_reason text DEFAULT NULL
) RETURNS TABLE (
  result_order_id uuid,
  new_status text,
  error_code text
) LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  current_order public.orders%ROWTYPE;
  target_status text;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO current_order FROM public.orders AS orders
  WHERE orders.id = requested_order_id
    AND orders.organization_id = current_org_id
    AND orders.deleted_at IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'NOT_FOUND'::text;
    RETURN;
  END IF;

  IF current_order.version <> requested_version THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'VERSION_CONFLICT'::text;
    RETURN;
  END IF;

  -- 合法迁移表就是这段 CASE，新增动作必须同时改这里和契约的 ORDER_ACTIONS。
  target_status := CASE requested_action
    WHEN 'confirm' THEN CASE WHEN current_order.status = 'booking' THEN 'active' END
    WHEN 'revert' THEN CASE WHEN current_order.status = 'active' THEN 'booking' END
    WHEN 'lock' THEN CASE WHEN current_order.status = 'active' THEN 'completed' END
    WHEN 'unlock' THEN CASE WHEN current_order.status = 'completed' THEN 'active' END
    WHEN 'cancel' THEN CASE WHEN current_order.status IN ('booking', 'active') THEN 'cancelled' END
    WHEN 'restore' THEN CASE WHEN current_order.status = 'cancelled' THEN coalesce(current_order.previous_status, 'active') END
  END;

  IF target_status IS NULL THEN
    RETURN QUERY SELECT NULL::uuid, NULL::text, 'ORDER_STATE_CONFLICT'::text;
    RETURN;
  END IF;

  UPDATE public.orders AS orders
  SET
    status = target_status,
    -- 取消时记下原状态，恢复动作据此回到原业务状态。
    previous_status = CASE WHEN requested_action = 'cancel' THEN current_order.status ELSE current_order.previous_status END,
    status_reason = requested_reason,
    version = current_order.version + 1,
    updated_by = (SELECT auth.uid ()),
    updated_at = now()
  WHERE orders.id = requested_order_id;

  RETURN QUERY SELECT requested_order_id, target_status, NULL::text;
END;
$$;


REVOKE ALL ON FUNCTION public.recalculate_order_totals (uuid),
public.create_order_with_items (
  uuid,
  text,
  jsonb,
  jsonb,
  text,
  date,
  date,
  integer,
  integer,
  text
),
public.update_order_with_items (
  uuid,
  integer,
  uuid,
  text,
  jsonb,
  jsonb,
  text,
  date,
  date,
  integer,
  integer,
  text
),
public.transition_order_status (uuid, text, integer, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON FUNCTION public.recalculate_order_totals (uuid),
public.create_order_with_items (
  uuid,
  text,
  jsonb,
  jsonb,
  text,
  date,
  date,
  integer,
  integer,
  text
),
public.update_order_with_items (
  uuid,
  integer,
  uuid,
  text,
  jsonb,
  jsonb,
  text,
  date,
  date,
  integer,
  integer,
  text
),
public.transition_order_status (uuid, text, integer, text) TO authenticated,
service_role;