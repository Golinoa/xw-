BEGIN;


SELECT
  plan (106);


-- ── 夹具 ────────────────────────────────────────────────────────────────────
-- 四个 auth 用户：平台管理员、只读（`ops_viewer`，只有 catalog.read）、
-- 没有运营行的租户成员、停用账号。
INSERT INTO
  auth.users (id, aud, role, email)
VALUES
  (
    '00000000-0000-4000-8000-0000000000d1',
    'authenticated',
    'authenticated',
    'catalog-admin@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d2',
    'authenticated',
    'authenticated',
    'catalog-viewer@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d3',
    'authenticated',
    'authenticated',
    'catalog-tenant@example.test'
  ),
  (
    '00000000-0000-4000-8000-0000000000d4',
    'authenticated',
    'authenticated',
    'catalog-disabled@example.test'
  );


INSERT INTO
  ops.operators (id, user_id, email, display_name, status)
VALUES
  (
    '00000000-0000-4000-8000-0000000000b1',
    '00000000-0000-4000-8000-0000000000d1',
    'catalog-admin@example.test',
    '目录域管理员',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000b2',
    '00000000-0000-4000-8000-0000000000d2',
    'catalog-viewer@example.test',
    '目录域只读',
    'active'
  ),
  (
    '00000000-0000-4000-8000-0000000000b3',
    '00000000-0000-4000-8000-0000000000d4',
    'catalog-disabled@example.test',
    '已停用管理员',
    'disabled'
  );


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000b1',
  role.id,
  '00000000-0000-4000-8000-0000000000b1'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000b2',
  role.id,
  '00000000-0000-4000-8000-0000000000b1'
FROM
  ops.roles AS role
WHERE
  role.code = 'ops_viewer';


INSERT INTO
  ops.operator_roles (operator_id, role_id, granted_by)
SELECT
  '00000000-0000-4000-8000-0000000000b3',
  role.id,
  '00000000-0000-4000-8000-0000000000b1'
FROM
  ops.roles AS role
WHERE
  role.code = 'platform_admin';


-- ── P1：能力面 ──────────────────────────────────────────────────────────────
-- 六张表对 authenticated 连 SELECT 都没有：读也走 RPC（salesModes[]、
-- packageCount、usageCount 这些聚合字段表达不了列级 grant）。
SELECT
  ok (
    NOT has_schema_privilege('anon', 'ops', 'USAGE'),
    'P1 anon has no usage on the ops schema'
  );


SELECT
  ok (
    NOT has_table_privilege('anon', 'ops.products', 'SELECT'),
    'P1 anon cannot select ops.products'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'anon',
      'ops.list_products(text,text,text)',
      'EXECUTE'
    ),
    'P1 anon cannot execute list_products'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.products', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'ops.products', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'ops.products', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'ops.products', 'DELETE'),
    'P1 authenticated has no direct access to ops.products'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.product_sales_modes',
      'SELECT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.product_sales_modes',
      'INSERT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.product_sales_modes',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.product_sales_modes',
      'DELETE'
    ),
    'P1 authenticated has no direct access to ops.product_sales_modes'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.packages', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'ops.packages', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'ops.packages', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'ops.packages', 'DELETE'),
    'P1 authenticated has no direct access to ops.packages'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.package_price_versions',
      'SELECT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.package_price_versions',
      'INSERT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.package_price_versions',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.package_price_versions',
      'DELETE'
    ),
    'P1 authenticated has no direct access to ops.package_price_versions'
  );


SELECT
  ok (
    NOT has_table_privilege(
      'authenticated',
      'ops.feature_definitions',
      'SELECT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.feature_definitions',
      'INSERT'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.feature_definitions',
      'UPDATE'
    )
    AND NOT has_table_privilege(
      'authenticated',
      'ops.feature_definitions',
      'DELETE'
    ),
    'P1 authenticated has no direct access to ops.feature_definitions'
  );


SELECT
  ok (
    NOT has_table_privilege('authenticated', 'ops.package_features', 'SELECT')
    AND NOT has_table_privilege('authenticated', 'ops.package_features', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'ops.package_features', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'ops.package_features', 'DELETE'),
    'P1 authenticated has no direct access to ops.package_features'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.product_json(uuid)',
      'EXECUTE'
    ),
    'the product shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.package_json(uuid)',
      'EXECUTE'
    ),
    'the package shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.price_version_json(uuid)',
      'EXECUTE'
    ),
    'the price-version shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.feature_json(text)',
      'EXECUTE'
    ),
    'the feature shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.package_feature_json(uuid,text)',
      'EXECUTE'
    ),
    'the package-feature shape helper is not callable by authenticated'
  );


SELECT
  ok (
    NOT has_function_privilege(
      'authenticated',
      'ops.catalog_reference_counts(text,uuid)',
      'EXECUTE'
    ),
    'the reference-count helper is not callable by authenticated'
  );


SELECT
  ok (
    (
      SELECT
        bool_and(class.relrowsecurity)
      FROM
        pg_class AS class
        JOIN pg_namespace AS namespace ON namespace.oid = class.relnamespace
      WHERE
        namespace.nspname = 'ops'
        AND class.relname IN (
          'products',
          'product_sales_modes',
          'packages',
          'package_price_versions',
          'feature_definitions',
          'package_features'
        )
    ),
    'row level security is enabled on all six catalog tables'
  );


-- ── P2：租户成员（没有 ops 行）─────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d3","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select count(*) from ops.products',
    '42501',
    NULL,
    'P2 a tenant member cannot read ops.products directly'
  );


SELECT
  throws_ok (
    'select ops.list_products()',
    '42501',
    NULL,
    'P2 a tenant member without an operator row cannot list products'
  );


RESET ROLE;


-- ── P3：只读账号没有 catalog.write ──────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d2","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    $$select ops.create_product('DENIED', '越权产品', null, '[{"mode":"saas"}]'::jsonb, null)$$,
    '42501',
    NULL,
    'P3 a viewer with catalog.read but not catalog.write cannot create a product'
  );


RESET ROLE;


-- ── P4：停用账号 ────────────────────────────────────────────────────────────
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d4","role":"authenticated"}',
    TRUE
  );


SET
  local role authenticated;


SELECT
  throws_ok (
    'select ops.list_products()',
    '42501',
    NULL,
    'P4 a disabled operator cannot list products'
  );


RESET ROLE;


-- ── 管理员视角 ──────────────────────────────────────────────────────────────
-- 从这里起用 JWT 声明扮演管理员，不再 `SET LOCAL ROLE authenticated`：断言需要
-- 回读 ops 表取 id，而 authenticated 本轮连 SELECT 都没有（那正是 P1）。
SELECT
  set_config(
    'request.jwt.claims',
    '{"sub":"00000000-0000-4000-8000-0000000000d1","role":"authenticated"}',
    TRUE
  );


CREATE TEMPORARY TABLE catalog_step (payload jsonb) ON
COMMIT
DROP;


-- ── 功能键 ──────────────────────────────────────────────────────────────────
DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_feature ('seats', '坐席数', 'quota', '个', '并发坐席数', '创建功能键');


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'an admin creates a feature definition'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{feature,value_type}'
      FROM
        catalog_step
    ),
    'quota',
    'the feature keeps its value type'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_feature ('seats', '坐席数', 'quota', '个', NULL, NULL);


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'feature_key_conflict',
    'a duplicate feature key is refused with an envelope, not a 500'
  );


SELECT
  IS (
    ops.list_features () #>> '{items,0,feature_key}',
    'seats',
    'the feature list returns the created key'
  );


SELECT
  IS (
    ops.list_features (p_keyword => '坐席') #>> '{items,0,feature_key}',
    'seats',
    'the feature keyword filter matches on the display name'
  );


SELECT
  IS (
    ops.update_feature ('seats', '并发坐席数', NULL, NULL, NULL, NULL) #>> '{feature,display_name}',
    '并发坐席数',
    'a feature display name can be updated'
  );


SELECT
  IS (
    ops.update_feature ('ghost', '幽灵', NULL, NULL, NULL, NULL) ->> 'status',
    'not_found',
    'updating an unknown feature key returns not_found'
  );


-- ── 产品 ────────────────────────────────────────────────────────────────────
DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_product (
    'ERP-SAAS',
    '云 ERP',
    '面向旅行社的 SaaS',
    '[{"mode":"saas","is_enabled":true},{"mode":"private","is_enabled":false}]'::jsonb,
    '创建产品'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'an admin creates a product'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,lifecycle_status}'
      FROM
        catalog_step
    ),
    'draft',
    'a new product starts in draft'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,version}'
      FROM
        catalog_step
    ),
    '1',
    'a new product starts at version 1'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,sales_modes,0,mode}'
      FROM
        catalog_step
    ),
    'private',
    'sales modes are ordered by mode name'
  );


SELECT
  IS (
    jsonb_array_length(
      (
        SELECT
          payload -> 'product' -> 'sales_modes'
        FROM
          catalog_step
      )
    ),
    2,
    'both sales modes are stored'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_product (
    'ERP-SAAS',
    '重复编码',
    NULL,
    '[{"mode":"saas","is_enabled":true}]'::jsonb,
    '重复编码'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'code_conflict',
    'a duplicate product code returns code_conflict instead of a 500'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_product ('ERP-EMPTY', '没有销售方式', NULL, '[]'::jsonb, '空销售方式');


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'sales_modes_required',
    'a product without sales modes is refused'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_product (
    'ERP-BAD',
    '非法销售方式',
    NULL,
    '[{"mode":"marketplace"}]'::jsonb,
    '非法销售方式'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'invalid_sales_mode',
    'an unknown sales mode is refused'
  );


SELECT
  IS (
    jsonb_array_length(ops.list_products () -> 'items'),
    1,
    'the product list returns exactly the one product'
  );


SELECT
  IS (
    ops.list_products (p_keyword => '云') #>> '{items,0,code}',
    'ERP-SAAS',
    'the product keyword filter matches on the name'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_products (p_sales_mode => 'private') -> 'items'
    ),
    1,
    'the sales-mode filter finds the product by an existing mode row'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_products (p_lifecycle_status => 'active') -> 'items'
    ),
    0,
    'the lifecycle filter excludes products in other states'
  );


SELECT
  ok (
    (
      ops.product_json (
        (
          SELECT
            id
          FROM
            ops.products
          WHERE
            code = 'ERP-SAAS'
        )
      )
    ) ?& ARRAY[
      'id',
      'code',
      'name',
      'description',
      'lifecycle_status',
      'sales_modes',
      'version',
      'created_at',
      'updated_at'
    ],
    'the product shape carries every contract key'
  );


SELECT
  throws_ok (
    $$insert into ops.products (code, name, lifecycle_status) values ('ERP-SAAS', '重复', 'draft')$$,
    '23505',
    NULL,
    'the product code is unique at the table level'
  );


SELECT
  throws_ok (
    $$insert into ops.product_sales_modes (product_id, sales_mode) values ((select id from ops.products where code = 'ERP-SAAS'), 'saas')$$,
    '23505',
    NULL,
    'a product can record each sales mode only once'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.update_product (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    '云 ERP 改名',
    NULL,
    NULL,
    NULL,
    99,
    '版本过期',
    NULL
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'version_mismatch',
    'a stale product version is refused'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'current_version'
      FROM
        catalog_step
    ),
    '1',
    'the mismatch envelope reports the current product version'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.update_product (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    NULL,
    NULL,
    'active',
    NULL,
    1,
    '产品上线',
    NULL
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'an admin can activate a product through PATCH'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,lifecycle_status}'
      FROM
        catalog_step
    ),
    'active',
    'the product lifecycle moves draft to active'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,version}'
      FROM
        catalog_step
    ),
    '2',
    'a product update bumps the optimistic-lock version'
  );


SELECT
  IS (
    ops.update_product (
      (
        SELECT
          id
        FROM
          ops.products
        WHERE
          code = 'ERP-SAAS'
      ),
      NULL,
      NULL,
      'draft',
      NULL,
      2,
      '回退',
      NULL
    ) ->> 'status',
    'invalid_transition',
    'an active product cannot go back to draft'
  );


-- ── 套餐 ────────────────────────────────────────────────────────────────────
DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_package (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    'PRIVATE 版',
    '私有部署版',
    'private',
    'periodic',
    12,
    'CNY',
    500000,
    '[]'::jsonb,
    '2026-01-01',
    '销售方式未开放'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'sales_mode_disabled',
    'creating a package in a disabled sales mode is refused'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_package (
    '00000000-0000-4000-8000-0000000000ff',
    '孤儿套餐',
    NULL,
    'saas',
    'periodic',
    12,
    'CNY',
    100,
    '[]'::jsonb,
    '2026-01-01',
    '产品不存在'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'product_not_found',
    'creating a package under an unknown product is refused'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_package (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    '未知权益版',
    NULL,
    'saas',
    'periodic',
    12,
    'CNY',
    100,
    '[{"feature_key":"ghost","enabled":true,"applies_to":"both"}]'::jsonb,
    '2026-01-01',
    '权益不存在'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'feature_not_found',
    'creating a package with an unknown feature key is refused'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'feature_key'
      FROM
        catalog_step
    ),
    'ghost',
    'the feature_not_found envelope names the unknown key'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_package (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    'PRO 版',
    '专业版',
    'saas',
    'periodic',
    12,
    'CNY',
    1200,
    '[{"feature_key":"seats","enabled":true,"quota_value":20,"term_months":12,"applies_to":"both"}]'::jsonb,
    '2026-01-01',
    '创建套餐'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'an admin creates a package with an embedded first price version'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,status}'
      FROM
        catalog_step
    ),
    'draft',
    'a new package starts in draft'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,list_price}'
      FROM
        catalog_step
    ),
    '1200.00',
    'the package list price keeps two decimals'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{price_version,version_no}'
      FROM
        catalog_step
    ),
    '1',
    'the first price version is number 1'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{price_version,price}'
      FROM
        catalog_step
    ),
    '1200.00',
    'the first price version carries the list price'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_package (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    'PRO 版',
    '重复名称',
    'saas',
    'periodic',
    12,
    'CNY',
    1300,
    '[]'::jsonb,
    '2026-02-01',
    '内部名称冲突'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'internal_name_conflict',
    'a duplicate package internal name is refused with an envelope'
  );


SELECT
  throws_ok (
    $$insert into ops.packages (product_id, internal_name, sales_mode, billing_type, list_price, status) values ((select id from ops.products where code = 'ERP-SAAS'), 'PRO 版', 'saas', 'periodic', 100, 'draft')$$,
    '23505',
    NULL,
    'the package internal name is unique per product and sales mode'
  );


SELECT
  throws_ok (
    $$insert into ops.packages (product_id, internal_name, sales_mode, billing_type, list_price, status) values ((select id from ops.products where code = 'ERP-SAAS'), 'NEG 版', 'saas', 'periodic', -1, 'draft')$$,
    '23514',
    NULL,
    'a negative list price violates the check constraint'
  );


SELECT
  IS (
    ops.get_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版'
      )
    ) ->> 'status',
    'ok',
    'the package detail is returned for an existing package'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.get_package (
        (
          SELECT
            id
          FROM
            ops.packages
          WHERE
            internal_name = 'PRO 版'
        )
      ) -> 'features'
    ),
    1,
    'the package detail carries its feature rows'
  );


SELECT
  IS (
    ops.get_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版'
      )
    ) #>> '{features,0,display_name}',
    '并发坐席数',
    'the package feature carries the feature display name'
  );


SELECT
  IS (
    ops.get_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版'
      )
    ) #>> '{current_price_version,version_no}',
    '1',
    'the package detail points at its current price version'
  );


SELECT
  IS (
    ops.get_package ('00000000-0000-4000-8000-0000000000ff') ->> 'status',
    'not_found',
    'an unknown package id returns not_found'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_packages (
        p_product_id => (
          SELECT
            id
          FROM
            ops.products
          WHERE
            code = 'ERP-SAAS'
        )
      ) -> 'items'
    ),
    1,
    'the package list filters by product'
  );


SELECT
  IS (
    ops.list_packages (
      p_product_id => (
        SELECT
          id
        FROM
          ops.products
        WHERE
          code = 'ERP-SAAS'
      )
    ) #>> '{items,0,price}',
    '1200.00',
    'the package list shows the current list price'
  );


SELECT
  IS (
    ops.list_features () #>> '{items,0,usage_count}',
    '1',
    'the feature list counts the package that uses the feature'
  );


SELECT
  ok (
    (
      ops.package_json (
        (
          SELECT
            id
          FROM
            ops.packages
          WHERE
            internal_name = 'PRO 版'
        )
      )
    ) ?& ARRAY[
      'id',
      'product_id',
      'product',
      'internal_name',
      'customer_name',
      'sales_mode',
      'billing_type',
      'default_term_months',
      'currency',
      'list_price',
      'status',
      'effective_from',
      'effective_to',
      'current_price_version_id',
      'version',
      'created_at',
      'updated_at'
    ],
    'the package shape carries every contract key'
  );


SELECT
  ok (
    (
      ops.price_version_json (
        (
          SELECT
            current_price_version_id
          FROM
            ops.packages
          WHERE
            internal_name = 'PRO 版'
        )
      )
    ) ?& ARRAY[
      'id',
      'package_id',
      'version_no',
      'price',
      'currency',
      'term_months',
      'effective_from',
      'created_by',
      'created_at'
    ],
    'the price-version shape carries every contract key'
  );


SELECT
  ok (
    (
      ops.package_feature_json (
        (
          SELECT
            id
          FROM
            ops.packages
          WHERE
            internal_name = 'PRO 版'
        ),
        'seats'
      )
    ) ?& ARRAY[
      'feature_key',
      'display_name',
      'enabled',
      'quota_value',
      'term_months',
      'applies_to'
    ],
    'the package-feature shape carries every contract key'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.update_package (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版'
    ),
    'PRO 版 2027',
    NULL,
    NULL,
    99,
    '版本过期'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'version_mismatch',
    'a stale package version is refused'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.update_package (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版'
    ),
    'PRO 版 2027',
    NULL,
    NULL,
    1,
    '套餐改名'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'an admin can rename a package'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,version}'
      FROM
        catalog_step
    ),
    '2',
    'a package update bumps the optimistic-lock version'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.update_package (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版 2027'
    ),
    NULL,
    NULL,
    '[{"feature_key":"seats","enabled":true,"quota_value":50,"term_months":12,"applies_to":"both"}]'::jsonb,
    2,
    '调整权益'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'package features are replaced as a whole'
  );


SELECT
  IS (
    ops.get_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版 2027'
      )
    ) #>> '{features,0,quota_value}',
    '50.00',
    'the replaced feature keeps the new quota'
  );


-- ── 价格版本 ────────────────────────────────────────────────────────────────
DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.create_package_price_version (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版 2027'
    ),
    1500,
    'CNY',
    12,
    '2026-04-01',
    '调价'
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'an admin adds a package price version'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{price_version,version_no}'
      FROM
        catalog_step
    ),
    '2',
    'the price version number increments'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,list_price}'
      FROM
        catalog_step
    ),
    '1500.00',
    'the package list price follows the newest price version'
  );


SELECT
  IS (
    jsonb_array_length(
      ops.list_package_price_versions (
        (
          SELECT
            id
          FROM
            ops.packages
          WHERE
            internal_name = 'PRO 版 2027'
        )
      ) -> 'items'
    ),
    2,
    'the price-version history carries both versions'
  );


SELECT
  IS (
    ops.list_package_price_versions (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版 2027'
      )
    ) #>> '{items,1,version_no}',
    '2',
    'the newest price version is the second entry'
  );


SELECT
  IS (
    ops.list_package_price_versions ('00000000-0000-4000-8000-0000000000ff') ->> 'status',
    'not_found',
    'the price-version list of an unknown package returns not_found'
  );


-- 只 INSERT：authenticated 连表级 UPDATE/DELETE 都没有，尝试修改应在权限层拒绝。
SET
  local role authenticated;


SELECT
  throws_ok (
    'update ops.package_price_versions set price = 1',
    '42501',
    NULL,
    'price versions are insert-only: UPDATE is denied'
  );


SELECT
  throws_ok (
    'delete from ops.package_price_versions',
    '42501',
    NULL,
    'price versions are insert-only: DELETE is denied'
  );


RESET ROLE;


-- ── 状态机与引用守卫 ────────────────────────────────────────────────────────
-- 一张没有价格版本的套餐：`create_package` 总会写首条价格版本，所以直接插入。
INSERT INTO
  ops.packages (
    product_id,
    internal_name,
    sales_mode,
    billing_type,
    list_price,
    status
  )
VALUES
  (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    '无价格版',
    'saas',
    'periodic',
    100,
    'draft'
  );


SELECT
  IS (
    ops.transition_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = '无价格版'
      ),
      'activate',
      '无价格版本',
      1,
      NULL
    ) ->> 'status',
    'price_version_required',
    'activating a package without a price version is refused'
  );


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.transition_package (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版 2027'
    ),
    'activate',
    '套餐上线',
    3,
    NULL
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'ok',
    'a package with a price version can be activated'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,status}'
      FROM
        catalog_step
    ),
    'active',
    'activate moves draft to active'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,version}'
      FROM
        catalog_step
    ),
    '4',
    'a package transition bumps the version'
  );


SELECT
  IS (
    ops.transition_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版 2027'
      ),
      'activate',
      '重复开通',
      4,
      NULL
    ) ->> 'status',
    'invalid_transition',
    'activating an active package is refused'
  );


-- T-06（第 23 个迁移）落地后 `ops.contracts` / `ops.contract_items` 是真实表。
-- 这里原来建的是同事务内的替身表，真实表存在时会撞名，所以改为写真实行。
-- 真实表 `customer_id` 是 NOT NULL + FK，本文件此前没有客户夹具，补一个。
-- `catalog_reference_counts` 只数 `status in ('draft','reviewing')` 的条目：
-- 草拟中的算引用，已签署的不算。
INSERT INTO
  ops.customers (name, status)
VALUES
  ('套餐引用夹具客户', 'active');


INSERT INTO
  ops.contracts (contract_no, customer_id, sales_mode, status)
SELECT
  'HT-REF-CAT-DRAFT',
  id,
  'saas',
  'draft'
FROM
  ops.customers
WHERE
  name = '套餐引用夹具客户';


INSERT INTO
  ops.contracts (contract_no, customer_id, sales_mode, status)
SELECT
  'HT-REF-CAT-SIGNED',
  id,
  'saas',
  'signed'
FROM
  ops.customers
WHERE
  name = '套餐引用夹具客户';


INSERT INTO
  ops.contract_items (
    contract_id,
    package_id,
    sales_mode,
    billing_type,
    unit_price,
    amount,
    item_name_snapshot,
    line_no
  )
SELECT
  contract.id,
  package.id,
  'saas',
  'periodic',
  0,
  0,
  package.internal_name,
  1
FROM
  ops.contracts AS contract
  CROSS JOIN ops.packages AS package
WHERE
  contract.contract_no = 'HT-REF-CAT-DRAFT'
  AND package.internal_name = 'PRO 版 2027';


INSERT INTO
  ops.contract_items (
    contract_id,
    package_id,
    sales_mode,
    billing_type,
    unit_price,
    amount,
    item_name_snapshot,
    line_no
  )
SELECT
  contract.id,
  package.id,
  'saas',
  'periodic',
  0,
  0,
  package.internal_name,
  1
FROM
  ops.contracts AS contract
  CROSS JOIN ops.packages AS package
WHERE
  contract.contract_no = 'HT-REF-CAT-SIGNED'
  AND package.internal_name = 'PRO 版 2027';


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.transition_package (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版 2027'
    ),
    'retire',
    '套餐下线',
    4,
    NULL
  );


SELECT
  IS (
    (
      SELECT
        payload ->> 'status'
      FROM
        catalog_step
    ),
    'referenced',
    'retiring a package referenced by a draft contract is refused'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{impact,draft_contracts}'
      FROM
        catalog_step
    ),
    '1',
    'the referenced envelope counts only draft and reviewing contracts'
  );


DELETE FROM ops.contracts
WHERE
  status = 'draft';


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.transition_package (
    (
      SELECT
        id
      FROM
        ops.packages
      WHERE
        internal_name = 'PRO 版 2027'
    ),
    'retire',
    '套餐下线',
    4,
    NULL
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{package,status}'
      FROM
        catalog_step
    ),
    'retired',
    'retire moves an active package to retired once no draft contract references it'
  );


SELECT
  IS (
    ops.transition_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版 2027'
      ),
      'retire',
      '再次下线',
      5,
      NULL
    ) ->> 'status',
    'invalid_transition',
    'retired is a terminal state for packages'
  );


SELECT
  IS (
    ops.transition_package (
      (
        SELECT
          id
        FROM
          ops.packages
        WHERE
          internal_name = 'PRO 版 2027'
      ),
      'activate',
      '终态激活',
      5,
      NULL
    ) ->> 'status',
    'invalid_transition',
    'a retired package cannot be activated'
  );


-- ── 产品停用守卫 ────────────────────────────────────────────────────────────
-- 用 contract_no 精确定位：前面「套餐 retire」那组已经造过一条 draft 合同，
-- 若按 status 匹配会把条目挂到两条合同上，产品引用计数就说不清是哪一个造成的。
INSERT INTO
  ops.contracts (contract_no, customer_id, sales_mode, status)
SELECT
  'HT-REF-CAT-PRODUCT',
  id,
  'saas',
  'draft'
FROM
  ops.customers
WHERE
  name = '套餐引用夹具客户';


INSERT INTO
  ops.contract_items (
    contract_id,
    product_id,
    sales_mode,
    billing_type,
    unit_price,
    amount,
    item_name_snapshot,
    line_no
  )
SELECT
  contract.id,
  product.id,
  'saas',
  'periodic',
  0,
  0,
  product.name,
  1
FROM
  ops.contracts AS contract
  CROSS JOIN ops.products AS product
WHERE
  contract.contract_no = 'HT-REF-CAT-PRODUCT'
  AND product.code = 'ERP-SAAS';


SELECT
  IS (
    ops.update_product (
      (
        SELECT
          id
        FROM
          ops.products
        WHERE
          code = 'ERP-SAAS'
      ),
      NULL,
      NULL,
      'retired',
      NULL,
      2,
      '产品停用',
      NULL
    ) ->> 'status',
    'referenced',
    'retiring a product referenced by a draft contract is refused'
  );


SELECT
  IS (
    ops.update_product (
      (
        SELECT
          id
        FROM
          ops.products
        WHERE
          code = 'ERP-SAAS'
      ),
      NULL,
      NULL,
      'retired',
      NULL,
      2,
      '产品停用',
      NULL
    ) #>> '{impact,draft_contracts}',
    '1',
    'the product referenced envelope carries the impact count'
  );


DELETE FROM ops.contracts
WHERE
  status = 'draft';


DELETE FROM catalog_step;


INSERT INTO
  catalog_step
SELECT
  ops.update_product (
    (
      SELECT
        id
      FROM
        ops.products
      WHERE
        code = 'ERP-SAAS'
    ),
    NULL,
    NULL,
    'retired',
    NULL,
    2,
    '产品停用',
    NULL
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,lifecycle_status}'
      FROM
        catalog_step
    ),
    'retired',
    'a product retires once no draft contract references it'
  );


SELECT
  IS (
    (
      SELECT
        payload #>> '{product,version}'
      FROM
        catalog_step
    ),
    '3',
    'the product retire bumps the version'
  );


SELECT
  IS (
    ops.update_product (
      (
        SELECT
          id
        FROM
          ops.products
        WHERE
          code = 'ERP-SAAS'
      ),
      NULL,
      NULL,
      'active',
      NULL,
      3,
      '终态激活',
      NULL
    ) ->> 'status',
    'invalid_transition',
    'a retired product cannot go back to active'
  );


-- 这里不能再 DROP：两张表现在都是 T-06 的真实表，删掉会破坏同库后续测试文件。
-- 替身表时代的 drop 清理随替身表一起移除；测试整体在事务里回滚，不留残留。
-- ── 审计 ────────────────────────────────────────────────────────────────────
SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'product.created'
    ),
    'product.created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'product.updated'
    ),
    'product.updated is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'package.created'
    ),
    'package.created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'package.price_version_created'
    ),
    'package.price_version_created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'package.transitioned'
    ),
    'package.transitioned is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'feature.created'
    ),
    'feature.created is written to the audit trail'
  );


SELECT
  ok (
    EXISTS (
      SELECT
        1
      FROM
        ops.audit_events AS event
      WHERE
        event.action = 'feature.updated'
    ),
    'feature.updated is written to the audit trail'
  );


SELECT
  *
FROM
  finish ();


ROLLBACK;