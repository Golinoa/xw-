-- C5 游客名单（R-TOURIST-01）。
--
-- 现状：全仓没有游客表，订单详情里的「游客名单」没有落脚点，人数只能靠
-- `orders.adult_count` / `child_count` 两个申报值，谁上了团、证件号是多少都无从记录。
--
-- 三条业务规则决定了这张表的形状：
--
-- 1. **同一订单内按「证件类型 + 规范化证件号」去重**。规范化只做两件事：去掉
--    空白与连字符、统一大写。写成生成列而不是让调用方传，是因为唯一索引必须
--    建在规范化值上——否则 `110101199001011234` 与 `110101-19900101-1234`
--    会被当成两个人，而 CSV 导入恰恰最容易出现这种写法差异。
-- 2. **证件号为空不合并**。所以唯一索引是部分索引（`WHERE normalized_document_number
--    IS NOT NULL`）：NULL 在唯一索引里互不相等，正好表达「没有号码就没有可比的
--    身份」。把空串折成 NULL 由生成列里的 nullif 完成，调用方不需要记得这件事。
-- 3. **证件类型是号码的前提**。有号码没类型，去重键就少一维，护照与身份证同号
--    （现实中存在）会被误合并。CHECK 直接禁止这种行，而不是在应用层靠自觉。
--
-- 权限刻意**不新增** `tourist.*`：游客是订单聚合的一部分，「能看这张单」就该能看
-- 它的名单，「能改这张单」就该能改名单。另立一套权限只会多出「有 order.write
-- 却改不了名单」这类没有任何业务含义的组合。可见性也不自己算：策略用
-- `EXISTS (SELECT 1 FROM public.orders ...)`，组织、权限、数据范围、软删除全由
-- orders 自己的策略决定——同一份规则只写一处，日后放宽订单可见性时名单自然跟随。
CREATE TABLE public.tourists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  order_id uuid NOT NULL,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  phone text,
  document_type text CHECK (
    document_type IS NULL
    OR document_type IN (
      'id_card',
      'passport',
      'hk_macau_permit',
      'taiwan_permit'
    )
  ),
  document_number text,
  normalized_document_number text GENERATED ALWAYS AS (
    nullif(
      upper(
        regexp_replace(
          btrim(coalesce(document_number, '')),
          '[\s\-]',
          '',
          'g'
        )
      ),
      ''
    )
  ) STORED,
  person_type text NOT NULL DEFAULT 'adult' CHECK (person_type IN ('adult', 'child')),
  age integer CHECK (
    age IS NULL
    OR age BETWEEN 0 AND 150
  ),
  gender text NOT NULL DEFAULT 'unknown' CHECK (gender IN ('male', 'female', 'unknown')),
  remark text,
  created_by uuid NOT NULL DEFAULT auth.uid () REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tourists_order_fk FOREIGN KEY (order_id, organization_id) REFERENCES public.orders (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT tourists_document_type_required CHECK (
    coalesce(btrim(document_number), '') = ''
    OR document_type IS NOT NULL
  )
);


CREATE INDEX tourists_order_idx ON public.tourists (order_id, created_at);


-- 去重键。部分索引让「没有证件号」的行彼此不冲突，这正是需求要的语义。
CREATE UNIQUE INDEX tourists_order_document_key ON public.tourists (
  order_id,
  document_type,
  normalized_document_number
)
WHERE
  normalized_document_number IS NOT NULL;


COMMENT ON TABLE public.tourists IS '订单游客名单。同订单按证件类型 + 规范化证件号去重，空号码不参与去重。';


ALTER TABLE public.tourists enable ROW level security;


REVOKE ALL ON public.tourists
FROM
  public,
  anon,
  authenticated;


GRANT
SELECT
,
  INSERT,
UPDATE,
DELETE ON public.tourists TO authenticated;


-- 读：订单可见即可见。`EXISTS` 里的 orders 查询同样受 orders 的 RLS 约束，
-- 因此组织隔离、`order.read`、`own` 数据范围与「已删除订单不可读」四条规则
-- 都自动生效，不需要在这里再抄一遍。
CREATE POLICY tourists_select_reader ON public.tourists FOR
SELECT
  TO authenticated USING (
    EXISTS (
      SELECT
        1
      FROM
        public.orders AS orders
      WHERE
        orders.id = tourists.order_id
    )
  );


-- 写：能改订单才能改名单。`created_by` 由数据库默认值填，策略再校验一次，
-- 让「伪造创建人」在库层面不成立（与 routes 同一口径）。
CREATE POLICY tourists_insert_writer ON public.tourists FOR insert TO authenticated
WITH
  CHECK (
    (
      SELECT
        public.has_permission ('order.write')
    )
    AND created_by = (
      SELECT
        auth.uid ()
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS orders
      WHERE
        orders.id = tourists.order_id
    )
  );


CREATE POLICY tourists_update_writer ON public.tourists
FOR UPDATE
  TO authenticated USING (
    (
      SELECT
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS orders
      WHERE
        orders.id = tourists.order_id
    )
  )
WITH
  CHECK (
    (
      SELECT
        public.has_permission ('order.write')
    )
    AND EXISTS (
      SELECT
        1
      FROM
        public.orders AS orders
      WHERE
        orders.id = tourists.order_id
    )
  );


CREATE POLICY tourists_delete_writer ON public.tourists FOR DELETE TO authenticated USING (
  (
    SELECT
      public.has_permission ('order.write')
  )
  AND EXISTS (
    SELECT
      1
    FROM
      public.orders AS orders
    WHERE
      orders.id = tourists.order_id
  )
);


-- CSV 导入的唯一写入口。
--
-- 为什么放在库里而不是在服务层拼两次 PostgREST 调用：覆盖模式必须
-- 「先删后插」，两次调用之间进程一挂，名单就没了——这不是理论问题，Worker 随时
-- 可能被回收。plpgsql 函数体本身是一个事务，任何一行校验失败都会把整批
-- （含刚做完的 DELETE）一起回滚，这才是需求要的「不产生部分写入」。
--
-- SECURITY INVOKER（默认）而不是 DEFINER：函数里的读走 orders 的 RLS，
-- 写走 tourists 自己的策略，越权在最后一道防线上仍然拦得住。
CREATE OR REPLACE FUNCTION public.import_tourists (
  requested_order_id uuid,
  requested_mode text,
  requested_rows jsonb
) RETURNS TABLE (inserted_count integer, deleted_count integer) LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid;
  removed integer := 0;
  added integer := 0;
BEGIN
  IF requested_mode NOT IN ('append', 'replace') THEN
    RAISE EXCEPTION 'import mode must be append or replace' USING ERRCODE = '22023';
  END IF;

  -- 订单的可见性由 orders 的 RLS 决定：读不到就是「不存在」，与其它端点的 404 口径一致。
  SELECT orders.organization_id INTO current_org_id
  FROM public.orders AS orders
  WHERE orders.id = requested_order_id;

  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'order not found' USING ERRCODE = 'P0002';
  END IF;

  -- 覆盖模式会删数据，先把写权限说清楚：没有 order.write 时策略会让 UPDATE/DELETE
  -- 静默过滤成 0 行，用户看到的会是「导入成功但名单没变」，比报错糟得多。
  IF NOT (SELECT public.has_permission ('order.write')) THEN
    RAISE EXCEPTION 'order.write is required' USING ERRCODE = '42501';
  END IF;

  IF requested_mode = 'replace' THEN
    DELETE FROM public.tourists AS tourists
    WHERE tourists.order_id = requested_order_id;
    GET DIAGNOSTICS removed = row_count;
  END IF;

  INSERT INTO public.tourists (
    organization_id,
    order_id,
    name,
    phone,
    document_type,
    document_number,
    person_type,
    age,
    gender,
    remark
  )
  SELECT
    current_org_id,
    requested_order_id,
    rows.name,
    nullif(btrim(rows.phone), ''),
    nullif(btrim(rows.document_type), ''),
    nullif(btrim(rows.document_number), ''),
    rows.person_type,
    rows.age,
    coalesce(nullif(btrim(rows.gender), ''), 'unknown'),
    nullif(btrim(rows.remark), '')
  FROM
    pg_catalog.jsonb_to_recordset (coalesce(requested_rows, '[]'::jsonb)) AS rows (
      name text,
      phone text,
      document_type text,
      document_number text,
      person_type text,
      age integer,
      gender text,
      remark text
    );
  GET DIAGNOSTICS added = row_count;

  RETURN QUERY
  SELECT
    added,
    removed;
END;
$$;


REVOKE ALL ON FUNCTION public.import_tourists (uuid, text, jsonb)
FROM
  PUBLIC;


GRANT
EXECUTE ON FUNCTION public.import_tourists (uuid, text, jsonb) TO authenticated;