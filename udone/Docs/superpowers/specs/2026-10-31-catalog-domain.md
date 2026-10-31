# catalog 域规格（T-05 / `o-t05`）—— 两个子会话共读的唯一口径

契约真源：`ERP-ops/admin/Docs/ops-api-contract.md` §3.2（表）、§5.3（13 端点）、§7.3（A2 归类）。
本轮只做 catalog：产品、套餐、价格版本、功能键、套餐权益。合同域（T-06）不在本轮。

## 0. 边界（越界即冲突）

| 谁 | 只许改这些文件 |
|---|---|
| DB 会话 | `supabase/migrations/20261030000009_ops_catalog_domain.sql`、`supabase/tests/ops_catalog_domain.sql` |
| API 会话 | `packages/contracts/src/ops/catalog.ts`、`packages/contracts/src/ops/index.ts`（加一行 export）、`packages/contracts/src/ops/audit-actions.ts`（追加词）、`packages/contracts/src/routes.ts`（在 `OPS_ROUTES` 末尾追加 13 条）、`apps/api/src/modules/ops/catalog/{protocol.ts,routes.ts,routes.test.ts}`、`apps/api/src/index.ts`（挂载） |

集成测试（`tests/integration/ops-catalog.test.ts`）由编排方在本轮末尾写，两个会话都不要碰。
不要改 `2026103000000{1..8}` 任何迁移，不要改客户域/身份域代码。

## 1. 表（照契约 §3.2；标「推断」的是契约没写死、本轮定的）

六张表，全部 `ops.` schema。

1. `ops.products`：`id uuid pk`、`code text NOT NULL`、`name text NOT NULL`、`description text`、
   `lifecycle_status text NOT NULL CHECK IN ('draft','active','retired')`、`version int NOT NULL DEFAULT 1`、
   审计列（`created_at/updated_at/created_by/updated_by`，与客户域同形）。`UNIQUE(code)`。
2. `ops.product_sales_modes`：`product_id uuid NOT NULL REFERENCES products ON DELETE CASCADE`、
   `sales_mode text NOT NULL CHECK IN ('saas','private')`、`is_enabled boolean NOT NULL DEFAULT false`。
   `PK(product_id, sales_mode)`。
3. `ops.packages`：`id`、`product_id uuid NOT NULL REFERENCES products ON DELETE RESTRICT`、
   `internal_name text`、`customer_name text`、`sales_mode text NOT NULL`（同枚举）、
   `billing_type text NOT NULL CHECK IN ('periodic','fixed_term','one_time')`、
   `default_term_months int`、`currency char(3) NOT NULL DEFAULT 'CNY'`、
   `list_price numeric(14,2) NOT NULL CHECK (list_price >= 0)`、
   `status text NOT NULL CHECK IN ('draft','active','retired')`（**推断**：契约 §3.2 未枚举
   `packages.status`，§5.3 只给了 `activate`/`retire` 两个动作；三态与 products 对齐）、
   `effective_from date`、`effective_to date`、`current_price_version_id uuid`、
   `version int NOT NULL DEFAULT 1`、审计列。
   `UNIQUE(product_id, sales_mode, internal_name)`、`INDEX(status, product_id)`。
   `current_price_version_id` 用 `REFERENCES ops.package_price_versions(id) ON DELETE SET NULL`，
   建表顺序必须是 products → packages → package_price_versions → 再 `ALTER TABLE` 补这个外键。
4. `ops.package_price_versions`：`id`、`package_id uuid NOT NULL REFERENCES packages ON DELETE CASCADE`、
   `version_no int NOT NULL CHECK (version_no > 0)`、`price numeric(14,2) NOT NULL CHECK (price >= 0)`、
   `currency char(3) NOT NULL`、`term_months int`、`effective_from date NOT NULL`、
   `created_by uuid REFERENCES operators(id) ON DELETE SET NULL`、`created_at timestamptz NOT NULL DEFAULT now()`。
   `UNIQUE(package_id, version_no)`。**仅 INSERT**：没有 UPDATE/DELETE 的 RPC，也撤掉表级写权限。
5. `ops.feature_definitions`：`feature_key text PRIMARY KEY`、`display_name text NOT NULL`、
   `value_type text NOT NULL CHECK IN ('boolean','quota','term')`、`unit text`、`description text`、
   `is_active boolean NOT NULL DEFAULT true`、审计列（这里用 `created_at/updated_at/updated_by`）。
6. `ops.package_features`：`package_id uuid NOT NULL REFERENCES packages ON DELETE CASCADE`、
   `feature_key text NOT NULL REFERENCES feature_definitions(feature_key) ON DELETE RESTRICT`、
   `enabled boolean NOT NULL DEFAULT true`、`quota_value numeric(14,2)`、`term_months int`、
   `applies_to text NOT NULL CHECK IN ('saas_tenant','private_instance','both')`。
   `PK(package_id, feature_key)`。

RLS 与授权：六张表全部 `ENABLE ROW LEVEL SECURITY` 且**不建策略**，
`REVOKE ALL ON TABLE ... FROM public, anon, authenticated`（与客户域同口径：读也走 RPC）。
契约 §7.3 把 `products`/`product_sales_modes`/`feature_definitions` 归 A1（可列级直写），
本轮按 RPC-only 实现，理由写进迁移头注释：与 §5.3 的 `salesModes[]`、`packageCount`、
`usageCount` 这些聚合字段冲突——直读拿不到聚合，会得到「字段缺失」的第二种形状。

## 2. 形状函数（无权限判定，必须撤掉 authenticated 的 EXECUTE）

- `ops.product_json(p_product_id uuid) returns jsonb` →
  `{id, code, name, description, lifecycle_status, sales_modes: [{mode, is_enabled}], version, created_at, updated_at}`
  （`sales_modes` 按 `sales_mode` 升序，保证同一行多次读取顺序稳定）。
- `ops.package_json(p_package_id uuid) returns jsonb` →
  `{id, product_id, product: {id, code, name}, internal_name, customer_name, sales_mode, billing_type,
    default_term_months, currency, list_price, status, effective_from, effective_to,
    current_price_version_id, version, created_at, updated_at}`
- `ops.price_version_json(p_price_version_id uuid) returns jsonb` →
  `{id, package_id, version_no, price, currency, term_months, effective_from, created_by, created_at}`
- `ops.feature_json(p_feature_key text) returns jsonb` →
  `{feature_key, display_name, value_type, unit, description, is_active, created_at, updated_at}`
- `ops.package_feature_json(p_package_id uuid, p_feature_key text) returns jsonb` →
  `{feature_key, display_name, enabled, quota_value, term_months, applies_to}`

金额与价格一律 `numeric(14,2)`，`jsonb_build_object` 出来是 JSON number，不要转成字符串。
金额/价格出站时由 API 层的 zod 用 `z.number()` 接（客户域没这个形态，这里要注意）。

## 3. 引用守卫（本轮合同表还不存在）

`ops.catalog_reference_counts(p_entity text, p_id uuid) returns jsonb`，用
`to_regclass('ops.contract_items')` / `to_regclass('ops.contracts')` 守卫 + 动态 SQL，
返回 `{draft_contracts: n}`。表不存在时返回 `{"draft_contracts": 0}`，不报错。
语义：`draft_contracts` = 处于 `draft`/`reviewing` 且引用该产品/套餐的合同条目数。

用途两处：
- `update_product` 把 `lifecycle_status` 改成 `retired` 且 `draft_contracts > 0` → `referenced`；
- `transition_package` 的 `retire` 同上。

`ops.contract_items` 还没有，实现时**不要**建替身表；pgTAP 里想测引用分支就在测试事务内
临时 `CREATE TABLE ops.contract_items (...)` 再 `DROP`（客户域 `ops_customer_domain.sql`
已有同样做法，可参照那一段的列清单）。

## 4. RPC 清单（13 个，签名即契约）

返回一律是 `jsonb`，形状 `{status: <词>, ...}`。**业务失败不进 RAISE**，只有权限不足走
`ops.require_permission` 抛 42501（与客户域一致）。所有函数 `SECURITY DEFINER` +
`SET search_path = ''`，表名一律写全 `ops.xxx`。

| # | RPC | 参数（顺序即位置） | 成功返回 | 失败词 |
|---|---|---|---|---|
| 1 | `ops.list_products` | `p_keyword text, p_lifecycle_status text, p_sales_mode text` | `{status:'ok', items:[{id,code,name,lifecycle_status,sales_modes:[{mode,is_enabled}],package_count,version}]}` | — |
| 2 | `ops.create_product` | `p_code text, p_name text, p_description text, p_sales_modes jsonb, p_request_id text` | `{status:'ok', product:{...product_json}}` | `code_conflict` |
| 3 | `ops.update_product` | `p_product_id uuid, p_name text, p_description text, p_lifecycle_status text, p_sales_modes jsonb, p_expected_version int, p_reason text, p_request_id text` | `{status:'ok', product:{...}}` | `not_found` / `version_mismatch`(+`current_version`) / `referenced`(+`impact`) |
| 4 | `ops.list_packages` | `p_product_id uuid, p_sales_mode text, p_status text, p_keyword text` | `{status:'ok', items:[{id,product_id,internal_name,customer_name,sales_mode,billing_type,price,currency,status,effective_from,version}]}` | — |
| 5 | `ops.create_package` | `p_product_id uuid, p_internal_name text, p_customer_name text, p_sales_mode text, p_billing_type text, p_default_term_months int, p_currency text, p_list_price numeric, p_features jsonb, p_effective_from date, p_request_id text` | `{status:'ok', package:{...}, price_version:{...}}` | `product_not_found` / `sales_mode_disabled` / `internal_name_conflict` / `feature_not_found`(+`feature_key`) |
| 6 | `ops.get_package` | `p_package_id uuid` | `{status:'ok', package:{...}, features:[{feature_key,display_name,enabled,quota_value,term_months,applies_to}], current_price_version:{...}\|null}` | `not_found` |
| 7 | `ops.update_package` | `p_package_id uuid, p_internal_name text, p_customer_name text, p_features jsonb, p_expected_version int, p_request_id text` | `{status:'ok', package:{...}}` | `not_found` / `version_mismatch` / `internal_name_conflict` / `feature_not_found` |
| 8 | `ops.create_package_price_version` | `p_package_id uuid, p_price numeric, p_currency text, p_term_months int, p_effective_from date, p_request_id text` | `{status:'ok', price_version:{...}, package:{...}}` | `not_found` / `price_version_conflict` |
| 9 | `ops.list_package_price_versions` | `p_package_id uuid` | `{status:'ok', items:[{version_no,price,currency,term_months,effective_from,created_by,created_at}]}` | `not_found` |
| 10 | `ops.transition_package` | `p_package_id uuid, p_action text, p_reason text, p_expected_version int, p_request_id text` | `{status:'ok', package:{status,version}, impact}` | `not_found` / `version_mismatch` / `invalid_transition` / `referenced`(+`impact`) |
| 11 | `ops.list_features` | `p_is_active boolean, p_keyword text` | `{status:'ok', items:[{feature_key,display_name,value_type,unit,is_active,usage_count}]}` | — |
| 12 | `ops.create_feature` | `p_feature_key text, p_display_name text, p_value_type text, p_unit text, p_description text, p_request_id text` | `{status:'ok', feature:{...}}` | `feature_key_conflict` |
| 13 | `ops.update_feature` | `p_feature_key text, p_display_name text, p_unit text, p_description text, p_is_active boolean, p_request_id text` | `{status:'ok', feature:{...}}` | `not_found` |

约定：
- 可选参数用 `NULL` 表示「不改」；空串表示清空（与 D-02 的 `p_display_name` 同口径）。
- `p_sales_modes`（jsonb 数组，元素 `{mode, is_enabled}`）：`NULL` = 不动；`'[]'` = 全删（不允许，返回
  `sales_modes_required`）——产品至少要有一条销售方式记录才可销售。传入的 mode 必须都在枚举内，
  否则 `invalid_sales_mode`。
- `p_features`（jsonb 数组，元素 `{feature_key, enabled, quota_value, term_months, applies_to}`）：
  `NULL` = 不动；`'[]'` = 清空全部权益。**整体替换**语义（先删后插），不是合并。
- `create_product` / `create_package` / `create_package_price_version` 都写审计；
  `update_*` 只在确实有字段变化时写，`before/after` 摘要只带变更过的键。
- 版本号：`packages` 与 `products` 用 `version + 1`（乐观锁）；`package_price_versions` 用
  `coalesce(max(version_no), 0) + 1`，取号前对 `ops.packages` 行 `FOR UPDATE`，
  避免并发取同号。
- `create_package` 同时写首条价格版本（`version_no = 1`），并回填
  `packages.current_price_version_id` 与 `list_price`/`currency`。
- `create_package_price_version` 成功后同步把 `packages.current_price_version_id`、
  `list_price`、`currency` 改成新版本的值（**推断**：`list_price` 的语义是「当前价」，
  不跟新版本就会让价格版本在列表里不可见；已生效合同用 `unit_price` 快照，不受影响）。

## 5. 状态机（推断，契约只给了动作名）

`packages.status`：`draft → active`（`activate`）、`draft|active → retired`（`retire`）。
`retired` 是终态，再次 `retire` 返回 `invalid_transition`（不是幂等成功）。
`activate` 的守卫：必须至少有一条价格版本（否则 `price_version_required`）。
`retire` 的守卫：`draft_contracts > 0` → `referenced`。

`products.lifecycle_status` 走 PATCH 而不是 transition 端点（契约 §5.3 就是这么分的）：
`draft → active → retired`，允许 `draft → retired`；`retired` 后不允许回到 `draft`/`active`
（返回 `invalid_transition`）。产品改 `retired` 且 `draft_contracts > 0` → `referenced`。

## 6. 审计动作词（追加到 `packages/contracts/src/ops/audit-actions.ts`）

`product.created`、`product.updated`、`package.created`、`package.updated`、
`package.transitioned`、`package.price_version_created`、`feature.created`、`feature.updated`。
八条，`entity_type` 分别是 `product`/`package`/`feature`。

## 7. API 层映射

HTTP 与错误码（与客户域 `routes.ts` 同构，`ERROR_CODES` 取 `packages/contracts/src/errors.ts`）：

| 信封 status | HTTP | code | details |
|---|---|---|---|
| `ok`（GET/PATCH） | 200 | — | — |
| `ok`（POST 新建，含 price-version） | **201** | — | — |
| `not_found` / `product_not_found` | 404 | `NOT_FOUND` | — |
| `version_mismatch` | 409 | `CONFLICT` | `{currentVersion}` |
| `code_conflict` / `internal_name_conflict` / `feature_key_conflict` / `price_version_conflict` | 409 | `CONFLICT` | `{field}`（`code`/`internalName`/`featureKey`/`versionNo`） |
| `sales_mode_disabled` | 400 | `VALIDATION_ERROR` | `{reason:'SALES_MODE_DISABLED', salesMode}` |
| `sales_modes_required` / `invalid_sales_mode` / `feature_not_found` / `price_version_required` | 400 | `VALIDATION_ERROR` | `{reason: <大写下划线同名>}` 及必要字段 |
| `invalid_transition` | 409 | `STATE_CONFLICT` | `{reason:'INVALID_TRANSITION'}` |
| `referenced` | 409 | `OBJECT_REFERENCED` | `{impact}` |

`GET` 三个列表的 query 校验：`keyword`（≤64，trim 后可空）、枚举筛选值不合法 → 400
`VALIDATION_ERROR`（不要静默忽略——静默忽略会让 `?lifecycleStatus=actve` 返回全集，
看起来像「筛选没生效」）。

幂等：`POST` 三个（create product / create package / create price-version / transition package
共四个）在 handler 里显式校验 `Idempotency-Key`；`PATCH` 不要求。全局中间件对缺键请求
直接放行，所以必须在 handler 里断言（客户域已有先例，照抄那三处）。

契约字段前端 camelCase、数据库 snake_case，出站映射放在 `protocol.ts`；
入站 zod 一律 `z.strictObject`（未知字段 → 400）。

## 8. 测试要求

DB 会话：`supabase/tests/ops_catalog_domain.sql`，`plan(N)` 必须等于实际断言数。
至少覆盖：P1（anon 无 USAGE）/ P2（租户成员查 ops 表 0 行）/ 三张表对 authenticated
无 SELECT 与写权限；六张表的约束（`UNIQUE(code)`、`UNIQUE(product_id, sales_mode, internal_name)`、
`PK(product_id, sales_mode)`、`CHECK(list_price >= 0)`）；`create_product` 重复 code 返回
`code_conflict` 而不是 500；乐观锁 `version_mismatch`；`create_package` 在销售方式未开放时
返回 `sales_mode_disabled`；`draft_contracts` 引用守卫（临时建 `ops.contract_items` 替身）；
价格版本号递增且只 INSERT（尝试 UPDATE 该表应因权限被拒）；`retired` 终态与
`price_version_required`；形状函数对 authenticated 无 EXECUTE。

API 会话：`routes.test.ts` 覆盖 13 个 handler 的成功与每个失败分支（含
「缺 Idempotency-Key → 400」与「query 枚举非法 → 400」），不 mock 数据库层以外的东西。

## 9. 不许做的事

- 不建 `ops.contracts` / `ops.contract_items` 真表（那是 T-06）。
- 不为了让测试过而放宽约束或加 `--no-verify`。
- 不在 handler 里写路径字符串（必须走 `OPS_ROUTES`）。
- 不新增 `packages.status` 第四态、不改契约已有字段名。
