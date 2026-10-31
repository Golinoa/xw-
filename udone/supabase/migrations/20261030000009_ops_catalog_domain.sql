-- 运营目录域：六张表 + 五个形状函数 + 引用计数 + 十三个 RPC（契约 §3.2、§5.3）。
--
-- 设计要点：
--
-- 1. 写路径只有 SECURITY DEFINER RPC。契约 §7.3 把 products / product_sales_modes /
--    feature_definitions 归在 A1（可列级直写），本轮仍按 RPC-only 实现：同一份契约
--    §5.3 的列表项要求 `salesModes[]`、`packageCount`、`usageCount` 这些聚合字段，
--    列级 grant 表达不了聚合。直读能拿到的行会少几个键，于是同一张表出现两种形状，
--    「字段缺失」比「没有权限」更难排查。给了一半权限的表比一张都不给更难解释。
--
-- 2. 业务失败用 `{status:...}` 信封，不 RAISE。理由与 `20261030000007` 一致：
--    PostgREST 把任何非 2xx 压成状态码，返回值才是可分辨的分支。只有权限不足
--    仍走 `ops.require_permission` 抛 42501——那不是业务分支。
--
-- 3. `packages.current_price_version_id` 指向后建的 `package_price_versions`，
--    所以这个外键在两张表都建好之后才用 ALTER TABLE 补。建表顺序必须是
--    products → packages → package_price_versions → ALTER。
--
-- 4. `package_price_versions` 只 INSERT：没有 UPDATE/DELETE 的 RPC，表级写权限也
--    一并撤掉。价格版本是「已生效合同 unit_price 快照」的证据链，能改就能让历史
--    对不上；改价只能新增一条。
--
-- 5. 合同表是 T-06，本轮还不存在。`ops.catalog_reference_counts()` 因此用
--    `to_regclass` 守卫 + 动态 SQL：直接引用会让函数在创建时就失败，而 retire 的
--    引用守卫必须现在接上。合同域落地后把分支里的表名换成真实表名即可，语义不变。
--
-- 6. 状态机（规格 §5）：`packages` 走 `draft→active`（activate）、
--    `draft|active→retired`（retire）；`products` 走 PATCH 的
--    `draft→active→retired`（允许 `draft→retired`）。两者的 `retired` 都是终态。
CREATE TABLE ops.products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  name text NOT NULL,
  description text,
  lifecycle_status text NOT NULL CHECK (
    lifecycle_status IN ('draft', 'active', 'retired')
  ),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT products_code_key UNIQUE (code)
);


-- 销售方式是「产品可卖的门」：一条记录都不存在就不能销售，`create_package` 会在
-- 这里找不到 `is_enabled` 的行并返回 `sales_mode_disabled`。
CREATE TABLE ops.product_sales_modes (
  product_id uuid NOT NULL REFERENCES ops.products (id) ON DELETE CASCADE,
  sales_mode text NOT NULL CHECK (sales_mode IN ('saas', 'private')),
  is_enabled boolean NOT NULL DEFAULT FALSE,
  PRIMARY KEY (product_id, sales_mode)
);


CREATE TABLE ops.packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES ops.products (id) ON DELETE RESTRICT,
  internal_name text,
  customer_name text,
  sales_mode text NOT NULL CHECK (sales_mode IN ('saas', 'private')),
  billing_type text NOT NULL CHECK (
    billing_type IN ('periodic', 'fixed_term', 'one_time')
  ),
  default_term_months integer,
  currency char(3) NOT NULL DEFAULT 'CNY',
  list_price numeric(14, 2) NOT NULL CHECK (list_price >= 0),
  -- 契约 §3.2 未枚举 packages.status（规格标「推断」）：三态与 products 对齐。
  status text NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
  effective_from date,
  effective_to date,
  -- 外键在 package_price_versions 建好之后补（见文件头第 3 条）。
  current_price_version_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  CONSTRAINT packages_product_sales_name_key UNIQUE (product_id, sales_mode, internal_name)
);


CREATE INDEX packages_status_product_idx ON ops.packages (status, product_id);


CREATE TABLE ops.package_price_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id uuid NOT NULL REFERENCES ops.packages (id) ON DELETE CASCADE,
  version_no integer NOT NULL CHECK (version_no > 0),
  price numeric(14, 2) NOT NULL CHECK (price >= 0),
  currency char(3) NOT NULL,
  term_months integer,
  effective_from date NOT NULL,
  created_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT package_price_versions_package_version_key UNIQUE (package_id, version_no)
);


ALTER TABLE ops.packages
ADD CONSTRAINT packages_current_price_version_fkey FOREIGN KEY (current_price_version_id) REFERENCES ops.package_price_versions (id) ON DELETE SET NULL;


CREATE TABLE ops.feature_definitions (
  feature_key text PRIMARY KEY,
  display_name text NOT NULL,
  value_type text NOT NULL CHECK (value_type IN ('boolean', 'quota', 'term')),
  unit text,
  description text,
  is_active boolean NOT NULL DEFAULT TRUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES ops.operators (id) ON DELETE SET NULL
);


CREATE TABLE ops.package_features (
  package_id uuid NOT NULL REFERENCES ops.packages (id) ON DELETE CASCADE,
  feature_key text NOT NULL REFERENCES ops.feature_definitions (feature_key) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT TRUE,
  quota_value numeric(14, 2),
  term_months integer,
  applies_to text NOT NULL CHECK (
    applies_to IN ('saas_tenant', 'private_instance', 'both')
  ),
  PRIMARY KEY (package_id, feature_key)
);


-- ── 引用计数（前向兼容） ────────────────────────────────────────────────────
-- postgres 里 `to_regclass` 是运行期判定，配合动态 SQL 才能让「表还不存在」变成
-- 返回 0 而不是创建函数时失败。两张表都缺一张就按 0 处理：合同条目单独存在时
-- 拿不到 `status`，数出来的是「所有条目」而不是「草拟条目」，那会是另一种语义。
CREATE OR REPLACE FUNCTION ops.catalog_reference_counts (p_entity text, p_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  draft_count integer := 0;
begin
  if p_id is null or p_entity not in ('product', 'package') then
    return jsonb_build_object('draft_contracts', 0);
  end if;

  if to_regclass('ops.contracts') is null
    or to_regclass('ops.contract_items') is null then
    return jsonb_build_object('draft_contracts', 0);
  end if;

  -- 列名不能作为参数绑定，用两条静态语句分支，而不是把 p_entity 拼进 SQL。
  if p_entity = 'product' then
    execute $sql$
      select count(*)
      from ops.contract_items as item
      join ops.contracts as contract on contract.id = item.contract_id
      where contract.status in ('draft', 'reviewing')
        and item.product_id = $1
    $sql$
      into draft_count
      using p_id;
  else
    execute $sql$
      select count(*)
      from ops.contract_items as item
      join ops.contracts as contract on contract.id = item.contract_id
      where contract.status in ('draft', 'reviewing')
        and item.package_id = $1
    $sql$
      into draft_count
      using p_id;
  end if;

  return jsonb_build_object('draft_contracts', draft_count);
end;
$$;


-- ── 形状函数 ────────────────────────────────────────────────────────────────
-- 与 `ops.customer_json` 同一口径：返回数据库列名（snake_case），出站映射负责
-- 拒绝字段漂移。这五个函数**没有**权限判定，必须对所有非属主角色关闭执行权，
-- 否则任意登录用户都能按 id 读到未授权的目录行与价格历史。
--
-- 金额/价格保持 JSON number（`numeric(14,2)` 直接进 `jsonb_build_object`），
-- 出站由 API 层用 `z.number()` 接；不要转成字符串，那会让同一个字段在客户域
-- 与目录域有两种类型。
CREATE OR REPLACE FUNCTION ops.product_json (p_product_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', product.id,
    'code', product.code,
    'name', product.name,
    'description', product.description,
    'lifecycle_status', product.lifecycle_status,
    'sales_modes', coalesce(
      (
        select jsonb_agg(
          jsonb_build_object('mode', mode.sales_mode, 'is_enabled', mode.is_enabled)
          order by mode.sales_mode
        )
        from ops.product_sales_modes as mode
        where mode.product_id = product.id
      ),
      '[]'::jsonb
    ),
    'version', product.version,
    'created_at', product.created_at,
    'updated_at', product.updated_at
  )
  from ops.products as product
  where product.id = p_product_id;
$$;


CREATE OR REPLACE FUNCTION ops.package_json (p_package_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', package.id,
    'product_id', package.product_id,
    'product', jsonb_build_object(
      'id', product.id,
      'code', product.code,
      'name', product.name
    ),
    'internal_name', package.internal_name,
    'customer_name', package.customer_name,
    'sales_mode', package.sales_mode,
    'billing_type', package.billing_type,
    'default_term_months', package.default_term_months,
    'currency', package.currency,
    'list_price', package.list_price,
    'status', package.status,
    'effective_from', package.effective_from,
    'effective_to', package.effective_to,
    'current_price_version_id', package.current_price_version_id,
    'version', package.version,
    'created_at', package.created_at,
    'updated_at', package.updated_at
  )
  from ops.packages as package
  join ops.products as product on product.id = package.product_id
  where package.id = p_package_id;
$$;


CREATE OR REPLACE FUNCTION ops.price_version_json (p_price_version_id uuid) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'id', version.id,
    'package_id', version.package_id,
    'version_no', version.version_no,
    'price', version.price,
    'currency', version.currency,
    'term_months', version.term_months,
    'effective_from', version.effective_from,
    'created_by', version.created_by,
    'created_at', version.created_at
  )
  from ops.package_price_versions as version
  where version.id = p_price_version_id;
$$;


CREATE OR REPLACE FUNCTION ops.feature_json (p_feature_key text) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'feature_key', feature.feature_key,
    'display_name', feature.display_name,
    'value_type', feature.value_type,
    'unit', feature.unit,
    'description', feature.description,
    'is_active', feature.is_active,
    'created_at', feature.created_at,
    'updated_at', feature.updated_at
  )
  from ops.feature_definitions as feature
  where feature.feature_key = p_feature_key;
$$;


CREATE OR REPLACE FUNCTION ops.package_feature_json (p_package_id uuid, p_feature_key text) returns jsonb language sql stable security definer
SET
  search_path = '' AS $$
  select jsonb_build_object(
    'feature_key', package_feature.feature_key,
    'display_name', feature.display_name,
    'enabled', package_feature.enabled,
    'quota_value', package_feature.quota_value,
    'term_months', package_feature.term_months,
    'applies_to', package_feature.applies_to
  )
  from ops.package_features as package_feature
  join ops.feature_definitions as feature on feature.feature_key = package_feature.feature_key
  where package_feature.package_id = p_package_id
    and package_feature.feature_key = p_feature_key;
$$;


-- ── GET /products ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_products (
  p_keyword text DEFAULT NULL,
  p_lifecycle_status text DEFAULT NULL,
  p_sales_mode text DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
begin
  perform ops.require_permission('catalog.read');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', product.id,
        'code', product.code,
        'name', product.name,
        'lifecycle_status', product.lifecycle_status,
        'sales_modes', coalesce(modes.value, '[]'::jsonb),
        'package_count', (
          select count(*)
          from ops.packages as package
          where package.product_id = product.id
        ),
        'version', product.version
      )
      order by product.code
    ),
    '[]'::jsonb
  )
  into items
  from ops.products as product
  left join lateral (
    select jsonb_agg(
      jsonb_build_object('mode', mode.sales_mode, 'is_enabled', mode.is_enabled)
      order by mode.sales_mode
    ) as value
    from ops.product_sales_modes as mode
    where mode.product_id = product.id
  ) as modes on true
  -- 销售方式筛选按「有这条记录」判定，不看 is_enabled：列表项已经带出
  -- is_enabled，筛「saas」是想看这条路线的产品，不是想隐藏已停用的记录。
  where (p_lifecycle_status is null or product.lifecycle_status = p_lifecycle_status)
    and (
      p_sales_mode is null
      or exists (
        select 1
        from ops.product_sales_modes as mode
        where mode.product_id = product.id
          and mode.sales_mode = p_sales_mode
      )
    )
    and (
      p_keyword is null
      or btrim(p_keyword) = ''
      or product.code ilike '%' || btrim(p_keyword) || '%'
      or product.name ilike '%' || btrim(p_keyword) || '%'
    );

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;


-- ── POST /products ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.create_product (
  p_code text,
  p_name text,
  p_description text,
  p_sales_modes jsonb,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  normalized_code text := btrim(coalesce(p_code, ''));
  normalized_name text := btrim(coalesce(p_name, ''));
  normalized_description text := nullif(btrim(coalesce(p_description, '')), '');
  modes jsonb := coalesce(p_sales_modes, '[]'::jsonb);
  new_id uuid;
  element jsonb;
begin
  perform ops.require_permission('catalog.write');

  if jsonb_typeof(modes) <> 'array' then
    return jsonb_build_object('status', 'invalid_sales_mode');
  end if;

  -- 产品至少要有一条销售方式记录才可销售（规格 §4）。空数组是「全删」，
  -- 对新建来说等于「建一个永远卖不出去的产品」，直接拒绝。
  if jsonb_array_length(modes) = 0 then
    return jsonb_build_object('status', 'sales_modes_required');
  end if;

  for element in
    select *
    from jsonb_array_elements(modes)
  loop
    if jsonb_typeof(element) <> 'object'
      or coalesce(element ->> 'mode', '') not in ('saas', 'private') then
      return jsonb_build_object(
        'status', 'invalid_sales_mode',
        'mode', element ->> 'mode'
      );
    end if;
  end loop;

  begin
    insert into ops.products (
      code, name, description, lifecycle_status, created_by, updated_by
    )
    values (
      normalized_code,
      normalized_name,
      normalized_description,
      'draft',
      actor_id,
      actor_id
    )
    returning id into new_id;
  exception
    when unique_violation then
      -- 唯一约束是兜底：并发下两个同 code 的创建只有一个能成功。
      return jsonb_build_object('status', 'code_conflict', 'field', 'code');
  end;

  insert into ops.product_sales_modes (product_id, sales_mode, is_enabled)
  select
    new_id,
    payload ->> 'mode',
    coalesce((payload ->> 'is_enabled')::boolean, false)
  from jsonb_array_elements(modes) as entry (payload)
  on conflict (product_id, sales_mode) do update
  set is_enabled = excluded.is_enabled;

  perform ops.write_audit(
    'product.created',
    'product',
    new_id,
    NULL,
    NULL,
    jsonb_build_object(
      'code', normalized_code,
      'name', normalized_name,
      'lifecycleStatus', 'draft',
      'salesModes', modes
    ),
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'product', ops.product_json(new_id));
end;
$$;


-- ── PATCH /products/{productId} ─────────────────────────────────────────────
-- 生命周期走 PATCH 而不是 transition 端点（契约 §5.3 就是这么分的）。四处守卫
-- 按 §5 的边逐条判定，不做「先算目标状态再统一校验」——`referenced` 只在
-- 「变成 retired 且之前不是」时触发，混在通用分支里会连改名也被拦。
CREATE OR REPLACE FUNCTION ops.update_product (
  p_product_id uuid,
  p_name text,
  p_description text,
  p_lifecycle_status text,
  p_sales_modes jsonb,
  p_expected_version integer,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.products;
  new_status text;
  effective_name text;
  effective_description text;
  current_modes jsonb;
  requested_modes jsonb;
  modes_changed boolean := false;
  changes jsonb := '{}'::jsonb;
  before_summary jsonb := '{}'::jsonb;
  impact jsonb;
  element jsonb;
begin
  perform ops.require_permission('catalog.write');

  -- FOR UPDATE：版本比较必须在锁内做，否则两个并发 PATCH 都读到 version=3。
  select * into target
  from ops.products as product
  where product.id = p_product_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  new_status := coalesce(p_lifecycle_status, target.lifecycle_status);

  if new_status is distinct from target.lifecycle_status then
    if not (
      (target.lifecycle_status = 'draft' and new_status in ('active', 'retired'))
      or (target.lifecycle_status = 'active' and new_status = 'retired')
    ) then
      return jsonb_build_object('status', 'invalid_transition');
    end if;
  end if;

  if new_status = 'retired' and target.lifecycle_status <> 'retired' then
    impact := ops.catalog_reference_counts('product', p_product_id);

    if coalesce((impact ->> 'draft_contracts')::integer, 0) > 0 then
      return jsonb_build_object('status', 'referenced', 'impact', impact);
    end if;
  end if;

  effective_name := case
    when p_name is null then target.name
    else btrim(p_name)
  end;

  effective_description := case
    when p_description is null then target.description
    else nullif(btrim(p_description), '')
  end;

  if p_sales_modes is not null then
    if jsonb_typeof(p_sales_modes) <> 'array'
      or jsonb_array_length(p_sales_modes) = 0 then
      return jsonb_build_object('status', 'sales_modes_required');
    end if;

    for element in
      select *
      from jsonb_array_elements(p_sales_modes)
    loop
      if jsonb_typeof(element) <> 'object'
        or coalesce(element ->> 'mode', '') not in ('saas', 'private') then
        return jsonb_build_object(
          'status', 'invalid_sales_mode',
          'mode', element ->> 'mode'
        );
      end if;
    end loop;

    select coalesce(
      jsonb_agg(
        jsonb_build_object('mode', mode.sales_mode, 'is_enabled', mode.is_enabled)
        order by mode.sales_mode
      ),
      '[]'::jsonb
    )
    into current_modes
    from ops.product_sales_modes as mode
    where mode.product_id = p_product_id;

    -- 去重后比较：同一批里重复的 mode 只是「最后一条生效」，不该被当成一次变更。
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'mode', normalized.mode,
          'is_enabled', normalized.is_enabled
        )
        order by normalized.mode
      ),
      '[]'::jsonb
    )
    into requested_modes
    from (
      select distinct on (payload ->> 'mode')
        payload ->> 'mode' as mode,
        coalesce((payload ->> 'is_enabled')::boolean, false) as is_enabled
      from jsonb_array_elements(p_sales_modes) as entry (payload)
      order by payload ->> 'mode'
    ) as normalized;

    modes_changed := current_modes is distinct from requested_modes;
  end if;

  if effective_name is distinct from target.name then
    changes := changes || jsonb_build_object('name', effective_name);
    before_summary := before_summary || jsonb_build_object('name', target.name);
  end if;

  if effective_description is distinct from target.description then
    changes := changes || jsonb_build_object('description', effective_description);
    before_summary := before_summary
      || jsonb_build_object('description', target.description);
  end if;

  if new_status is distinct from target.lifecycle_status then
    changes := changes || jsonb_build_object('lifecycle_status', new_status);
    before_summary := before_summary
      || jsonb_build_object('lifecycle_status', target.lifecycle_status);
  end if;

  if modes_changed then
    changes := changes || jsonb_build_object('sales_modes', requested_modes);
    before_summary := before_summary || jsonb_build_object('sales_modes', current_modes);
  end if;

  -- 没有字段变化就不写：空更新会把 version 推高，让调用方的乐观锁白失败一次。
  if changes = '{}'::jsonb then
    return jsonb_build_object('status', 'ok', 'product', ops.product_json(p_product_id));
  end if;

  update ops.products as product
  set
    name = effective_name,
    description = effective_description,
    lifecycle_status = new_status,
    version = product.version + 1,
    updated_at = now(),
    updated_by = actor_id
  where product.id = p_product_id;

  if modes_changed then
    delete from ops.product_sales_modes as mode
    where mode.product_id = p_product_id;

    insert into ops.product_sales_modes (product_id, sales_mode, is_enabled)
    select
      p_product_id,
      payload ->> 'mode',
      coalesce((payload ->> 'is_enabled')::boolean, false)
    from jsonb_array_elements(p_sales_modes) as entry (payload)
    on conflict (product_id, sales_mode) do update
    set is_enabled = excluded.is_enabled;
  end if;

  perform ops.write_audit(
    'product.updated',
    'product',
    p_product_id,
    p_reason,
    before_summary,
    changes,
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'product', ops.product_json(p_product_id));
end;
$$;


-- ── GET /packages ───────────────────────────────────────────────────────────
-- 列表里的 `price` 是 `packages.list_price`（当前价），不是价格版本表的最新一行：
-- 两者在 create/price-version 时同步，读路径只信 `packages` 才不会每次列表都
-- 对每个套餐再查一次子表。
CREATE OR REPLACE FUNCTION ops.list_packages (
  p_product_id uuid DEFAULT NULL,
  p_sales_mode text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_keyword text DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
begin
  perform ops.require_permission('catalog.read');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', package.id,
        'product_id', package.product_id,
        'internal_name', package.internal_name,
        'customer_name', package.customer_name,
        'sales_mode', package.sales_mode,
        'billing_type', package.billing_type,
        'price', package.list_price,
        'currency', package.currency,
        'status', package.status,
        'effective_from', package.effective_from,
        'version', package.version
      )
      order by package.created_at, package.id
    ),
    '[]'::jsonb
  )
  into items
  from ops.packages as package
  where (p_product_id is null or package.product_id = p_product_id)
    and (p_sales_mode is null or package.sales_mode = p_sales_mode)
    and (p_status is null or package.status = p_status)
    and (
      p_keyword is null
      or btrim(p_keyword) = ''
      or package.internal_name ilike '%' || btrim(p_keyword) || '%'
      or package.customer_name ilike '%' || btrim(p_keyword) || '%'
    );

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;


-- ── POST /packages ──────────────────────────────────────────────────────────
-- 套餐与首条价格版本同一事务写入：只写了一半的套餐（有套餐行、没有价格版本）
-- 会让 `activate` 永远返回 `price_version_required`，而用户明明在创建时填了价。
CREATE OR REPLACE FUNCTION ops.create_package (
  p_product_id uuid,
  p_internal_name text,
  p_customer_name text,
  p_sales_mode text,
  p_billing_type text,
  p_default_term_months integer,
  p_currency text,
  p_list_price numeric,
  p_features jsonb,
  p_effective_from date,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  new_id uuid;
  price_version_id uuid;
  effective_currency text := upper(
    coalesce(nullif(btrim(coalesce(p_currency, '')), ''), 'CNY')
  );
  effective_from date := coalesce(p_effective_from, current_date);
  features jsonb := coalesce(p_features, '[]'::jsonb);
  normalized_internal_name text := nullif(btrim(coalesce(p_internal_name, '')), '');
  normalized_customer_name text := nullif(btrim(coalesce(p_customer_name, '')), '');
  element jsonb;
begin
  perform ops.require_permission('catalog.write');

  if not exists (
    select 1 from ops.products as product where product.id = p_product_id
  ) then
    return jsonb_build_object('status', 'product_not_found');
  end if;

  -- 未开放（或根本没有这条记录）一律拒绝：枚举外的 mode 也落在这里，
  -- 免得 CHECK 约束把它变成 500。
  if not exists (
    select 1
    from ops.product_sales_modes as mode
    where mode.product_id = p_product_id
      and mode.sales_mode = p_sales_mode
      and mode.is_enabled
  ) then
    return jsonb_build_object(
      'status', 'sales_mode_disabled',
      'sales_mode', p_sales_mode
    );
  end if;

  -- 先校验后写入：`feature_not_found` 必须是纯拒绝，不能留下半条套餐。
  for element in
    select *
    from jsonb_array_elements(features)
  loop
    if not exists (
      select 1
      from ops.feature_definitions as feature
      where feature.feature_key = element ->> 'feature_key'
    ) then
      return jsonb_build_object(
        'status', 'feature_not_found',
        'feature_key', element ->> 'feature_key'
      );
    end if;
  end loop;

  begin
    insert into ops.packages (
      product_id, internal_name, customer_name, sales_mode, billing_type,
      default_term_months, currency, list_price, status, effective_from,
      created_by, updated_by
    )
    values (
      p_product_id,
      normalized_internal_name,
      normalized_customer_name,
      p_sales_mode,
      p_billing_type,
      p_default_term_months,
      effective_currency,
      p_list_price,
      'draft',
      effective_from,
      actor_id,
      actor_id
    )
    returning id into new_id;
  exception
    when unique_violation then
      return jsonb_build_object(
        'status', 'internal_name_conflict',
        'field', 'internal_name'
      );
  end;

  insert into ops.package_price_versions (
    package_id, version_no, price, currency, term_months, effective_from, created_by
  )
  values (
    new_id, 1, p_list_price, effective_currency, p_default_term_months,
    effective_from, actor_id
  )
  returning id into price_version_id;

  update ops.packages as package
  set current_price_version_id = price_version_id
  where package.id = new_id;

  if jsonb_array_length(features) > 0 then
    insert into ops.package_features (
      package_id, feature_key, enabled, quota_value, term_months, applies_to
    )
    select
      new_id,
      payload ->> 'feature_key',
      coalesce((payload ->> 'enabled')::boolean, true),
      (payload ->> 'quota_value')::numeric,
      (payload ->> 'term_months')::integer,
      payload ->> 'applies_to'
    from jsonb_array_elements(features) as entry (payload)
    on conflict (package_id, feature_key) do update
    set
      enabled = excluded.enabled,
      quota_value = excluded.quota_value,
      term_months = excluded.term_months,
      applies_to = excluded.applies_to;
  end if;

  perform ops.write_audit(
    'package.created',
    'package',
    new_id,
    NULL,
    NULL,
    jsonb_build_object(
      'productId', p_product_id,
      'internalName', normalized_internal_name,
      'salesMode', p_sales_mode,
      'listPrice', p_list_price,
      'currency', effective_currency,
      'priceVersionNo', 1,
      'featureCount', jsonb_array_length(features)
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'package', ops.package_json(new_id),
    'price_version', ops.price_version_json(price_version_id)
  );
end;
$$;


-- ── GET /packages/{packageId} ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.get_package (p_package_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  features jsonb;
  current_price_version jsonb;
begin
  perform ops.require_permission('catalog.read');

  if not exists (
    select 1 from ops.packages as package where package.id = p_package_id
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(
    jsonb_agg(
      ops.package_feature_json(
        package_feature.package_id,
        package_feature.feature_key
      )
      order by package_feature.feature_key
    ),
    '[]'::jsonb
  )
  into features
  from ops.package_features as package_feature
  where package_feature.package_id = p_package_id;

  select ops.price_version_json(package.current_price_version_id)
  into current_price_version
  from ops.packages as package
  where package.id = p_package_id;

  return jsonb_build_object(
    'status', 'ok',
    'package', ops.package_json(p_package_id),
    'features', features,
    'current_price_version', current_price_version
  );
end;
$$;


-- ── PATCH /packages/{packageId} ─────────────────────────────────────────────
-- `p_features` 是整体替换（先删后插），不是合并：权益是一次报价的完整快照，
-- 合并语义会让「删掉一条权益」无法表达——调用方只能传空值，而那与「不改」同形。
CREATE OR REPLACE FUNCTION ops.update_package (
  p_package_id uuid,
  p_internal_name text,
  p_customer_name text,
  p_features jsonb,
  p_expected_version integer,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.packages;
  effective_internal_name text;
  effective_customer_name text;
  current_features jsonb;
  requested_features jsonb;
  features_changed boolean := false;
  changes jsonb := '{}'::jsonb;
  before_summary jsonb := '{}'::jsonb;
  element jsonb;
begin
  perform ops.require_permission('catalog.write');

  select * into target
  from ops.packages as package
  where package.id = p_package_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  effective_internal_name := case
    when p_internal_name is null then target.internal_name
    else nullif(btrim(p_internal_name), '')
  end;

  effective_customer_name := case
    when p_customer_name is null then target.customer_name
    else nullif(btrim(p_customer_name), '')
  end;

  if p_features is not null then
    if jsonb_typeof(p_features) <> 'array' then
      return jsonb_build_object('status', 'feature_not_found');
    end if;

    for element in
      select *
      from jsonb_array_elements(p_features)
    loop
      if not exists (
        select 1
        from ops.feature_definitions as feature
        where feature.feature_key = element ->> 'feature_key'
      ) then
        return jsonb_build_object(
          'status', 'feature_not_found',
          'feature_key', element ->> 'feature_key'
        );
      end if;
    end loop;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'feature_key', package_feature.feature_key,
          'enabled', package_feature.enabled,
          'quota_value', package_feature.quota_value,
          'term_months', package_feature.term_months,
          'applies_to', package_feature.applies_to
        )
        order by package_feature.feature_key
      ),
      '[]'::jsonb
    )
    into current_features
    from ops.package_features as package_feature
    where package_feature.package_id = p_package_id;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'feature_key', normalized.feature_key,
          'enabled', normalized.enabled,
          'quota_value', normalized.quota_value,
          'term_months', normalized.term_months,
          'applies_to', normalized.applies_to
        )
        order by normalized.feature_key
      ),
      '[]'::jsonb
    )
    into requested_features
    from (
      select distinct on (payload ->> 'feature_key')
        payload ->> 'feature_key' as feature_key,
        coalesce((payload ->> 'enabled')::boolean, true) as enabled,
        (payload ->> 'quota_value')::numeric as quota_value,
        (payload ->> 'term_months')::integer as term_months,
        payload ->> 'applies_to' as applies_to
      from jsonb_array_elements(p_features) as entry (payload)
      order by payload ->> 'feature_key'
    ) as normalized;

    features_changed := current_features is distinct from requested_features;
  end if;

  if effective_internal_name is distinct from target.internal_name then
    changes := changes || jsonb_build_object('internal_name', effective_internal_name);
    before_summary := before_summary
      || jsonb_build_object('internal_name', target.internal_name);
  end if;

  if effective_customer_name is distinct from target.customer_name then
    changes := changes || jsonb_build_object('customer_name', effective_customer_name);
    before_summary := before_summary
      || jsonb_build_object('customer_name', target.customer_name);
  end if;

  if features_changed then
    changes := changes || jsonb_build_object('features', requested_features);
    before_summary := before_summary || jsonb_build_object('features', current_features);
  end if;

  if changes = '{}'::jsonb then
    return jsonb_build_object('status', 'ok', 'package', ops.package_json(p_package_id));
  end if;

  begin
    update ops.packages as package
    set
      internal_name = effective_internal_name,
      customer_name = effective_customer_name,
      version = package.version + 1,
      updated_at = now(),
      updated_by = actor_id
    where package.id = p_package_id;
  exception
    when unique_violation then
      return jsonb_build_object(
        'status', 'internal_name_conflict',
        'field', 'internal_name'
      );
  end;

  if features_changed then
    delete from ops.package_features as package_feature
    where package_feature.package_id = p_package_id;

    insert into ops.package_features (
      package_id, feature_key, enabled, quota_value, term_months, applies_to
    )
    select
      p_package_id,
      payload ->> 'feature_key',
      coalesce((payload ->> 'enabled')::boolean, true),
      (payload ->> 'quota_value')::numeric,
      (payload ->> 'term_months')::integer,
      payload ->> 'applies_to'
    from jsonb_array_elements(p_features) as entry (payload)
    on conflict (package_id, feature_key) do update
    set
      enabled = excluded.enabled,
      quota_value = excluded.quota_value,
      term_months = excluded.term_months,
      applies_to = excluded.applies_to;
  end if;

  perform ops.write_audit(
    'package.updated',
    'package',
    p_package_id,
    NULL,
    before_summary,
    changes,
    p_request_id
  );

  return jsonb_build_object('status', 'ok', 'package', ops.package_json(p_package_id));
end;
$$;


-- ── POST /packages/{packageId}/price-versions ───────────────────────────────
-- 取号前对 `ops.packages` 行 FOR UPDATE：并发两次新增若只靠 `max(version_no)+1`，
-- 两个事务会读到同一个 max，然后一个成功一个撞唯一约束（500 而不是 409）。
CREATE OR REPLACE FUNCTION ops.create_package_price_version (
  p_package_id uuid,
  p_price numeric,
  p_currency text,
  p_term_months integer,
  p_effective_from date,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.packages;
  next_version_no integer;
  new_id uuid;
  effective_currency text;
  effective_from date := coalesce(p_effective_from, current_date);
begin
  perform ops.require_permission('catalog.write');

  select * into target
  from ops.packages as package
  where package.id = p_package_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(max(version.version_no), 0) + 1
  into next_version_no
  from ops.package_price_versions as version
  where version.package_id = p_package_id;

  effective_currency := upper(
    coalesce(nullif(btrim(coalesce(p_currency, '')), ''), target.currency)
  );

  begin
    insert into ops.package_price_versions (
      package_id, version_no, price, currency, term_months, effective_from, created_by
    )
    values (
      p_package_id, next_version_no, p_price, effective_currency,
      p_term_months, effective_from, actor_id
    )
    returning id into new_id;
  exception
    when unique_violation then
      -- 行锁让同号只可能来自「有人绕过了取号」；仍是业务分支，不是 500。
      return jsonb_build_object(
        'status', 'price_version_conflict',
        'field', 'version_no',
        'version_no', next_version_no
      );
  end;

  -- `list_price` 的语义是「当前价」：不跟着新版本走，价格版本在列表里就不可见
  -- （规格 §4 推断）。已生效合同用 unit_price 快照，不受这次同步影响。
  --
  -- 这里**不** bump `packages.version`：规格只要求同步三列，而价格版本是追加的
  -- 独立历史（改价不改套餐本身），把乐观锁版本推高只会让手里拿着刚读到的 version
  -- 的调用方在无关的 PATCH 上白吃一次 409。
  update ops.packages as package
  set
    current_price_version_id = new_id,
    list_price = p_price,
    currency = effective_currency,
    updated_at = now(),
    updated_by = actor_id
  where package.id = p_package_id;

  perform ops.write_audit(
    'package.price_version_created',
    'package',
    p_package_id,
    NULL,
    jsonb_build_object(
      'priceVersionNo', next_version_no - 1,
      'listPrice', target.list_price,
      'currency', target.currency
    ),
    jsonb_build_object(
      'priceVersionNo', next_version_no,
      'listPrice', p_price,
      'currency', effective_currency
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'price_version', ops.price_version_json(new_id),
    'package', ops.package_json(p_package_id)
  );
end;
$$;


-- ── GET /packages/{packageId}/price-versions ────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_package_price_versions (p_package_id uuid) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
begin
  perform ops.require_permission('catalog.read');

  if not exists (
    select 1 from ops.packages as package where package.id = p_package_id
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'version_no', version.version_no,
        'price', version.price,
        'currency', version.currency,
        'term_months', version.term_months,
        'effective_from', version.effective_from,
        'created_by', version.created_by,
        'created_at', version.created_at
      )
      order by version.version_no
    ),
    '[]'::jsonb
  )
  into items
  from ops.package_price_versions as version
  where version.package_id = p_package_id;

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;


-- ── POST /packages/{packageId}/transition ───────────────────────────────────
-- 两条边逐条判定。`retired` 是终态：再次 retire 返回 `invalid_transition`，
-- 不做幂等成功——「已经停用了」与「这次停用成功了」对审计是两件事。
CREATE OR REPLACE FUNCTION ops.transition_package (
  p_package_id uuid,
  p_action text,
  p_reason text DEFAULT NULL,
  p_expected_version integer DEFAULT NULL,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.packages;
  to_status text;
  impact jsonb;
begin
  perform ops.require_permission('catalog.write');

  select * into target
  from ops.packages as package
  where package.id = p_package_id
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if p_expected_version is null or target.version <> p_expected_version then
    return jsonb_build_object(
      'status', 'version_mismatch',
      'current_version', target.version
    );
  end if;

  to_status := case
    when p_action = 'activate' and target.status = 'draft' then 'active'
    when p_action = 'retire' and target.status in ('draft', 'active') then 'retired'
  end;

  if to_status is null then
    return jsonb_build_object('status', 'invalid_transition');
  end if;

  if p_action = 'activate' and not exists (
    select 1
    from ops.package_price_versions as version
    where version.package_id = p_package_id
  ) then
    return jsonb_build_object('status', 'price_version_required');
  end if;

  impact := ops.catalog_reference_counts('package', p_package_id);

  if p_action = 'retire'
    and coalesce((impact ->> 'draft_contracts')::integer, 0) > 0 then
    return jsonb_build_object('status', 'referenced', 'impact', impact);
  end if;

  update ops.packages as package
  set
    status = to_status,
    version = package.version + 1,
    updated_at = now(),
    updated_by = actor_id
  where package.id = p_package_id;

  perform ops.write_audit(
    'package.transitioned',
    'package',
    p_package_id,
    p_reason,
    jsonb_build_object('status', target.status, 'action', p_action),
    jsonb_build_object('status', to_status, 'action', p_action, 'impact', impact),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'package', jsonb_build_object('status', to_status, 'version', target.version + 1),
    'impact', impact
  );
end;
$$;


-- ── GET /features ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION ops.list_features (
  p_is_active boolean DEFAULT NULL,
  p_keyword text DEFAULT NULL
) returns jsonb language plpgsql stable security definer
SET
  search_path = '' AS $$
declare
  items jsonb;
begin
  perform ops.require_permission('catalog.read');

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'feature_key', feature.feature_key,
        'display_name', feature.display_name,
        'value_type', feature.value_type,
        'unit', feature.unit,
        'is_active', feature.is_active,
        'usage_count', (
          select count(*)
          from ops.package_features as usage
          where usage.feature_key = feature.feature_key
        )
      )
      order by feature.feature_key
    ),
    '[]'::jsonb
  )
  into items
  from ops.feature_definitions as feature
  where (p_is_active is null or feature.is_active = p_is_active)
    and (
      p_keyword is null
      or btrim(p_keyword) = ''
      or feature.feature_key ilike '%' || btrim(p_keyword) || '%'
      or feature.display_name ilike '%' || btrim(p_keyword) || '%'
    );

  return jsonb_build_object('status', 'ok', 'items', items);
end;
$$;


-- ── POST /features ──────────────────────────────────────────────────────────
-- `feature_key` 是稳定键：审计的 entity_id 是 uuid，而这里的主键是 text，
-- 所以 entity_id 传 NULL、键放进 after 摘要——把 text 强转成 uuid 会直接报错。
CREATE OR REPLACE FUNCTION ops.create_feature (
  p_feature_key text,
  p_display_name text,
  p_value_type text,
  p_unit text,
  p_description text,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  normalized_key text := btrim(coalesce(p_feature_key, ''));
  normalized_display_name text := btrim(coalesce(p_display_name, ''));
  normalized_unit text := nullif(btrim(coalesce(p_unit, '')), '');
  normalized_description text := nullif(btrim(coalesce(p_description, '')), '');
begin
  perform ops.require_permission('catalog.write');

  begin
    insert into ops.feature_definitions (
      feature_key, display_name, value_type, unit, description
    )
    values (
      normalized_key,
      normalized_display_name,
      p_value_type,
      normalized_unit,
      normalized_description
    );
  exception
    when unique_violation then
      return jsonb_build_object(
        'status', 'feature_key_conflict',
        'field', 'feature_key'
      );
  end;

  perform ops.write_audit(
    'feature.created',
    'feature',
    NULL,
    NULL,
    NULL,
    jsonb_build_object(
      'featureKey', normalized_key,
      'displayName', normalized_display_name,
      'valueType', p_value_type
    ),
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'feature', ops.feature_json(normalized_key)
  );
end;
$$;


-- ── PATCH /features/{featureKey} ────────────────────────────────────────────
-- `value_type` 不可变：它是权益快照的解释器，改了会让历史上所有同键快照的读法
-- 变掉。参数表里没有这一列，比在函数体里判一次更难被后来的改动绕过。
CREATE OR REPLACE FUNCTION ops.update_feature (
  p_feature_key text,
  p_display_name text,
  p_unit text,
  p_description text,
  p_is_active boolean,
  p_request_id text DEFAULT NULL
) returns jsonb language plpgsql security definer
SET
  search_path = '' AS $$
declare
  actor_id uuid := ops.current_operator_id();
  target ops.feature_definitions;
  effective_display_name text;
  effective_unit text;
  effective_description text;
  effective_is_active boolean;
  changes jsonb := '{}'::jsonb;
  before_summary jsonb := '{}'::jsonb;
begin
  perform ops.require_permission('catalog.write');

  select * into target
  from ops.feature_definitions as feature
  where feature.feature_key = p_feature_key
  for update;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  effective_display_name := case
    when p_display_name is null then target.display_name
    else btrim(p_display_name)
  end;
  effective_unit := case
    when p_unit is null then target.unit
    else nullif(btrim(p_unit), '')
  end;
  effective_description := case
    when p_description is null then target.description
    else nullif(btrim(p_description), '')
  end;
  effective_is_active := coalesce(p_is_active, target.is_active);

  if effective_display_name is distinct from target.display_name then
    changes := changes || jsonb_build_object('display_name', effective_display_name);
    before_summary := before_summary
      || jsonb_build_object('display_name', target.display_name);
  end if;

  if effective_unit is distinct from target.unit then
    changes := changes || jsonb_build_object('unit', effective_unit);
    before_summary := before_summary || jsonb_build_object('unit', target.unit);
  end if;

  if effective_description is distinct from target.description then
    changes := changes || jsonb_build_object('description', effective_description);
    before_summary := before_summary
      || jsonb_build_object('description', target.description);
  end if;

  if effective_is_active is distinct from target.is_active then
    changes := changes || jsonb_build_object('is_active', effective_is_active);
    before_summary := before_summary
      || jsonb_build_object('is_active', target.is_active);
  end if;

  if changes = '{}'::jsonb then
    return jsonb_build_object(
      'status', 'ok',
      'feature', ops.feature_json(p_feature_key)
    );
  end if;

  update ops.feature_definitions as feature
  set
    display_name = effective_display_name,
    unit = effective_unit,
    description = effective_description,
    is_active = effective_is_active,
    updated_at = now(),
    updated_by = actor_id
  where feature.feature_key = p_feature_key;

  perform ops.write_audit(
    'feature.updated',
    'feature',
    NULL,
    NULL,
    before_summary,
    changes,
    p_request_id
  );

  return jsonb_build_object(
    'status', 'ok',
    'feature', ops.feature_json(p_feature_key)
  );
end;
$$;


-- ── 授权 ────────────────────────────────────────────────────────────────────
-- 六张表对 authenticated 连 SELECT 都没有：读也走 RPC（见文件头第 1 条）。
-- anon 本来就没有 schema USAGE，这里再撤一次表级权限是防「以后有人补授 USAGE」。
REVOKE ALL ON TABLE ops.products,
ops.product_sales_modes,
ops.packages,
ops.package_price_versions,
ops.feature_definitions,
ops.package_features
FROM
  public,
  anon,
  authenticated;


ALTER TABLE ops.products enable ROW level security;


ALTER TABLE ops.product_sales_modes enable ROW level security;


ALTER TABLE ops.packages enable ROW level security;


ALTER TABLE ops.package_price_versions enable ROW level security;


ALTER TABLE ops.feature_definitions enable ROW level security;


ALTER TABLE ops.package_features enable ROW level security;


-- 形状函数与计数函数没有权限判定，必须对所有非属主角色关闭：
-- 漏关一个，任何登录用户都能按 id 读到未授权的目录行与价格历史。
REVOKE ALL ON function ops.product_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.package_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.price_version_json (uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.feature_json (text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.package_feature_json (uuid, text)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.catalog_reference_counts (text, uuid)
FROM
  public,
  anon,
  authenticated;


REVOKE ALL ON function ops.list_products (text, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_product (text, text, text, jsonb, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_product (
  uuid,
  text,
  text,
  text,
  jsonb,
  integer,
  text,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_packages (uuid, text, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_package (
  uuid,
  text,
  text,
  text,
  text,
  integer,
  text,
  numeric,
  jsonb,
  date,
  text
)
FROM
  public,
  anon;


REVOKE ALL ON function ops.get_package (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_package (uuid, text, text, jsonb, integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_package_price_version (uuid, numeric, text, integer, date, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_package_price_versions (uuid)
FROM
  public,
  anon;


REVOKE ALL ON function ops.transition_package (uuid, text, text, integer, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.list_features (boolean, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.create_feature (text, text, text, text, text, text)
FROM
  public,
  anon;


REVOKE ALL ON function ops.update_feature (text, text, text, text, boolean, text)
FROM
  public,
  anon;


GRANT
EXECUTE ON function ops.list_products (text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_product (text, text, text, jsonb, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_product (
  uuid,
  text,
  text,
  text,
  jsonb,
  integer,
  text,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_packages (uuid, text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_package (
  uuid,
  text,
  text,
  text,
  text,
  integer,
  text,
  numeric,
  jsonb,
  date,
  text
) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.get_package (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_package (uuid, text, text, jsonb, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_package_price_version (uuid, numeric, text, integer, date, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_package_price_versions (uuid) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.transition_package (uuid, text, text, integer, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.list_features (boolean, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.create_feature (text, text, text, text, text, text) TO authenticated,
service_role;


GRANT
EXECUTE ON function ops.update_feature (text, text, text, text, boolean, text) TO authenticated,
service_role;


COMMENT ON TABLE ops.products IS '运营产品主数据（契约 §3.2）。code 唯一；lifecycle_status 只能经 ops.update_product 迁移，retired 是终态。';


COMMENT ON TABLE ops.product_sales_modes IS '产品可销售方式（saas/private）。没有 is_enabled 的行时 create_package 拒绝建档。';


COMMENT ON TABLE ops.packages IS '运营套餐。status 三态与 products 对齐（契约未枚举，按规格推断）；current_price_version_id 指向当前价格版本。';


COMMENT ON TABLE ops.package_price_versions IS '套餐价格版本，仅 INSERT：没有 UPDATE/DELETE 的 RPC，表级写权限也不授予。改价只能新增一条。';


COMMENT ON TABLE ops.feature_definitions IS '功能键定义。feature_key 是稳定键（不可变），value_type 决定权益的解释方式。';


COMMENT ON TABLE ops.package_features IS '套餐权益（整体替换语义）。applies_to 限定适用部署范围。';


COMMENT ON FUNCTION ops.catalog_reference_counts (text, uuid) IS '目录引用计数：草拟/评审中合同条目数。合同表未落地时用 to_regclass 跳过并返回 0；语义为 status IN (draft, reviewing) 且引用该产品/套餐的条目数。';


COMMENT ON FUNCTION ops.transition_package (uuid, text, text, integer, text) IS '套餐状态机（规格 §5）：draft→active（需至少一条价格版本）、draft|active→retired（草拟合同引用→referenced）；retired 是终态。业务失败走信封，不 RAISE。';