-- 客户主数据域（R-CUSTOMER-01、R-MASTER-01 标签部分）。
--
-- 设计要点：
-- 1. 所有业务外键都用 (业务列, organization_id) 复合外键，让「跨租户引用」在数据库层
--    就无法成立，而不是只靠 API 校验（DATABASE_STANDARDS.md §3、REQUIREMENTS.md §17.3）。
-- 2. 权限是表驱动的：新权限只要 INSERT 到 organization_role_permissions，
--    has_permission() 与 get_current_auth_context() 自动生效，无需改函数。
-- 3. 客户采用软删除（deleted_at/deleted_by），因为历史订单仍会引用客户快照；
--    物理删除不授予 authenticated，恢复与彻底删除留到回收站需求。
-- 4. phone_normalized 是生成列，避免应用层忘记归一化导致查重失效。
-- 5. 电话/证件号的掩码只在 API 响应层做，数据库永远存原值。PostgreSQL 的列级权限
--    是角色级的（authenticated 是统一角色），无法按租户内角色区分 readable 列；
--    而直连 PostgREST 需要 anon key，该 key 只存在于 Worker secrets、不进前端产物，
--    因此绕过 API 读原值的前提不成立。此边界在 journal 中记录为已知设计限制。
CREATE TABLE public.customer_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  parent_id uuid,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_sources_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT customer_sources_parent_tenant_fk FOREIGN KEY (parent_id, organization_id) REFERENCES public.customer_sources (id, organization_id) ON DELETE RESTRICT
);


CREATE UNIQUE INDEX customer_sources_root_name_idx ON public.customer_sources (organization_id, name)
WHERE
  parent_id IS NULL;


CREATE UNIQUE INDEX customer_sources_child_name_idx ON public.customer_sources (organization_id, parent_id, name)
WHERE
  parent_id IS NOT NULL;


CREATE INDEX customer_sources_organization_idx ON public.customer_sources (organization_id, sort_order);


CREATE TABLE public.customer_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  color text CHECK (
    color IS NULL
    OR color ~ '^#[0-9a-fA-F]{6}$'
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_tags_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT customer_tags_name_key UNIQUE (organization_id, name)
);


CREATE TABLE public.customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations (id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  phone text CHECK (
    phone IS NULL
    OR length(btrim(phone)) > 0
  ),
  phone_normalized text GENERATED ALWAYS AS (
    nullif(
      regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'),
      ''
    )
  ) STORED,
  email text,
  id_type text CHECK (
    id_type IS NULL
    OR id_type IN ('id_card', 'passport', 'other')
  ),
  id_number text,
  birthday date,
  source_id uuid,
  remark text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid NOT NULL REFERENCES auth.users (id) ON DELETE RESTRICT,
  updated_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid REFERENCES auth.users (id) ON DELETE RESTRICT,
  CONSTRAINT customers_id_organization_key UNIQUE (id, organization_id),
  CONSTRAINT customers_id_pair CHECK ((id_type IS NULL) = (id_number IS NULL)),
  CONSTRAINT customers_source_tenant_fk FOREIGN KEY (source_id, organization_id) REFERENCES public.customer_sources (id, organization_id) ON DELETE RESTRICT
);


CREATE INDEX customers_organization_created_idx ON public.customers (organization_id, created_at DESC)
WHERE
  deleted_at IS NULL;


CREATE INDEX customers_organization_phone_idx ON public.customers (organization_id, phone_normalized)
WHERE
  deleted_at IS NULL
  AND phone_normalized IS NOT NULL;


CREATE INDEX customers_organization_source_idx ON public.customers (organization_id, source_id)
WHERE
  deleted_at IS NULL;


CREATE INDEX customers_organization_creator_idx ON public.customers (organization_id, created_by)
WHERE
  deleted_at IS NULL;


CREATE TABLE public.customer_tag_links (
  customer_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (customer_id, tag_id),
  CONSTRAINT customer_tag_links_customer_fk FOREIGN KEY (customer_id, organization_id) REFERENCES public.customers (id, organization_id) ON DELETE CASCADE,
  CONSTRAINT customer_tag_links_tag_fk FOREIGN KEY (tag_id, organization_id) REFERENCES public.customer_tags (id, organization_id) ON DELETE CASCADE
);


CREATE INDEX customer_tag_links_tag_idx ON public.customer_tag_links (tag_id);


-- 客户域权限。保持与 packages/contracts/src/permissions.ts 的 ROLE_AUTHORIZATION 完全一致：
-- admin 全量；operator（计调员）可读写并看敏感字段，但数据范围是 own；
-- finance（财务）只读且看不到电话/证件原值（REQUIREMENTS.md §16.3）。
INSERT INTO
  public.organization_role_permissions (role, permission)
VALUES
  ('admin', 'customer.read'),
  ('admin', 'customer.write'),
  ('admin', 'customer.sensitive.read'),
  ('operator', 'customer.read'),
  ('operator', 'customer.write'),
  ('operator', 'customer.sensitive.read'),
  ('finance', 'customer.read')
ON CONFLICT (role, permission) DO NOTHING;


ALTER TABLE public.customer_sources enable ROW level security;


ALTER TABLE public.customer_tags enable ROW level security;


ALTER TABLE public.customers enable ROW level security;


ALTER TABLE public.customer_tag_links enable ROW level security;


REVOKE ALL ON public.customer_sources,
public.customer_tags,
public.customers,
public.customer_tag_links
FROM
  public,
  anon,
  authenticated;


-- 列级授权：organization_id 与 created_by 不可被 UPDATE 改写，phone_normalized 是生成列不可写。
GRANT
SELECT
  ON public.customers TO authenticated;


GRANT insert (
  organization_id,
  name,
  phone,
  email,
  id_type,
  id_number,
  birthday,
  source_id,
  remark,
  version,
  created_by
) ON public.customers TO authenticated;


GRANT
UPDATE (
  name,
  phone,
  email,
  id_type,
  id_number,
  birthday,
  source_id,
  remark,
  version,
  updated_by,
  updated_at,
  deleted_at,
  deleted_by
) ON public.customers TO authenticated;


GRANT
SELECT
,
  insert,
UPDATE ON public.customer_sources TO authenticated;


GRANT
SELECT
,
  insert,
UPDATE ON public.customer_tags TO authenticated;


GRANT
SELECT
,
  insert,
  DELETE ON public.customer_tag_links TO authenticated;


GRANT ALL ON public.customer_sources,
public.customer_tags,
public.customers,
public.customer_tag_links TO service_role;


CREATE POLICY customers_select_scoped ON public.customers FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.read')
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


CREATE POLICY customers_insert_writer ON public.customers FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
    )
    AND created_by = (
      SELECT
        auth.uid ()
    )
    AND deleted_at IS NULL
  );


-- WITH CHECK 不限制 deleted_at：软删除本身就是一次把 deleted_at 置非空的 UPDATE。
CREATE POLICY customers_update_writer ON public.customers
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
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
        public.has_permission ('customer.write')
    )
  );


CREATE POLICY customer_sources_select_reader ON public.customer_sources FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.read')
    )
  );


CREATE POLICY customer_sources_insert_writer ON public.customer_sources FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
    )
  );


CREATE POLICY customer_sources_update_writer ON public.customer_sources
FOR UPDATE
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
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
        public.has_permission ('customer.write')
    )
  );


CREATE POLICY customer_tags_select_reader ON public.customer_tags FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.read')
    )
  );


CREATE POLICY customer_tags_insert_writer ON public.customer_tags FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
    )
  );


CREATE POLICY customer_tag_links_select_reader ON public.customer_tag_links FOR
SELECT
  TO authenticated USING (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.read')
    )
  );


CREATE POLICY customer_tag_links_insert_writer ON public.customer_tag_links FOR insert TO authenticated
WITH
  CHECK (
    organization_id = (
      SELECT
        public.current_organization_id ()
    )
    AND (
      SELECT
        public.has_permission ('customer.write')
    )
  );


CREATE POLICY customer_tag_links_delete_writer ON public.customer_tag_links FOR delete TO authenticated USING (
  organization_id = (
    SELECT
      public.current_organization_id ()
  )
  AND (
    SELECT
      public.has_permission ('customer.write')
  )
);


-- 客户与标签关联必须在同一事务里成立：先建客户再补标签会留下「客户已存在但标签丢失」
-- 的中间态，用户重试又会造出重复客户。这里用 SECURITY INVOKER（默认）函数，
-- RLS 仍然按调用者身份生效，函数只是把两条 INSERT 收进一个事务。
CREATE OR REPLACE FUNCTION public.create_customer_with_tags (
  requested_name text,
  requested_tag_ids UUID[] DEFAULT '{}'::UUID[],
  requested_phone text DEFAULT NULL,
  requested_email text DEFAULT NULL,
  requested_id_type text DEFAULT NULL,
  requested_id_number text DEFAULT NULL,
  requested_birthday date DEFAULT NULL,
  requested_source_id uuid DEFAULT NULL,
  requested_remark text DEFAULT NULL
) RETURNS uuid LANGUAGE plpgsql
SET
  search_path = '' AS $$
DECLARE
  current_org_id uuid := public.current_organization_id ();
  new_customer_id uuid;
  tag_id uuid;
BEGIN
  IF current_org_id IS NULL THEN
    RAISE EXCEPTION 'organization context is required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.customers (
    organization_id,
    name,
    phone,
    email,
    id_type,
    id_number,
    birthday,
    source_id,
    remark,
    created_by
  )
VALUES
  (
    current_org_id,
    requested_name,
    requested_phone,
    requested_email,
    requested_id_type,
    requested_id_number,
    requested_birthday,
    requested_source_id,
    requested_remark,
    (SELECT auth.uid ())
  )
RETURNING
  id INTO new_customer_id;

  IF requested_tag_ids IS NOT NULL THEN
    FOREACH tag_id IN ARRAY requested_tag_ids LOOP
      INSERT INTO public.customer_tag_links (customer_id, tag_id, organization_id)
      VALUES (new_customer_id, tag_id, current_org_id);
    END LOOP;
  END IF;

  RETURN new_customer_id;
END;
$$;


REVOKE ALL ON FUNCTION public.create_customer_with_tags (
  text,
  UUID[],
  text,
  text,
  text,
  text,
  date,
  uuid,
  text
)
FROM
  public,
  anon;


GRANT
EXECUTE ON FUNCTION public.create_customer_with_tags (
  text,
  UUID[],
  text,
  text,
  text,
  text,
  date,
  uuid,
  text
) TO authenticated,
service_role;