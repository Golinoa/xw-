-- C4 线路主数据（R-ROUTE-01）。
--
-- 现状：`orders.route_name` 是纯文本，全库没有线路表，订单表单只能手打线路名。
-- 结果是同一个线路在不同订单里写法各异（「云南六日游」/「云南6日游」），
-- 既不能按线路统计，也无法保证线路改名后的历史可追溯。
--
-- 本迁移只建主数据表。**刻意不给 `orders` 加 `route_id` 外键**：
-- R-ROUTE-01 要求历史订单保留线路名称快照，而快照按值保存就够了——
-- 订单把选中线路的 `name` 拷进 `orders.route_name`，此后线路改名、停用、
-- 甚至删除都不会影响任何历史订单。加外键反而会诱导后来者 join 实时主数据，
-- 那正是需求禁止的漂移。
--
-- 线路类型 / 地区 / 出发城市在公司字典（R-SETTING-01）落地前保持自由文本：
-- 现在就把枚举写死，等于把「由公司维护」变成「由代码发布维护」。
CREATE TABLE public.routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  route_type text CHECK (route_type IS NULL OR length(btrim(route_type)) > 0),
  region text CHECK (region IS NULL OR length(btrim(region)) > 0),
  departure_city text CHECK (departure_city IS NULL OR length(btrim(departure_city)) > 0),
  days integer CHECK (days IS NULL OR days BETWEEN 1 AND 365),
  is_self_group boolean NOT NULL DEFAULT FALSE,
  is_active boolean NOT NULL DEFAULT TRUE,
  remark text,
  -- 由数据库填观察者，而不是让调用方传：插入策略要求 `created_by = auth.uid()`，
  -- 任何「客户端自己填 created_by」的写法都能被伪造。
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routes_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT routes_name_key UNIQUE (organization_id, name)
);


CREATE INDEX routes_organization_idx ON public.routes (organization_id, is_active, name);


COMMENT ON TABLE public.routes IS '线路主数据。订单只拷贝名称快照，不引用本表。';


-- 线路与供应商同属「订单要引用的主数据」，权限也对称：读写分开，财务只读。
INSERT INTO
  public.organization_role_permissions (role, permission)
VALUES
  ('admin', 'route.read'),
  ('admin', 'route.write'),
  ('operator', 'route.read'),
  ('operator', 'route.write'),
  ('finance', 'route.read')
ON CONFLICT (role, permission) DO NOTHING;


ALTER TABLE public.routes enable ROW level security;


REVOKE ALL ON public.routes
FROM
  public,
  anon,
  authenticated;


GRANT SELECT, INSERT, UPDATE, DELETE ON public.routes TO authenticated;


CREATE POLICY routes_select_reader ON public.routes FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('route.read')
    )
  );


CREATE POLICY routes_insert_writer ON public.routes FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('route.write')
    )
    AND created_by = (
      SELECT
        auth.uid ()
    )
  );


CREATE POLICY routes_update_writer ON public.routes
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('route.write')
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
        public.has_permission ('route.write')
    )
  );


CREATE POLICY routes_delete_writer ON public.routes FOR DELETE TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('route.write')
  )
);
