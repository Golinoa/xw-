# catalog 域（已实现）

契约：`Docs/ops-api-contract.md` §5.3（`/api/v1/ops/products|packages|features`），数据模型 §3.2。页面：`src/views/ops/catalog/`。

## 已实现端点

| 函数 | 方法与路径 |
| --- | --- |
| `fetchProducts` / `createProduct` | `GET\|POST /products` |
| `updateProduct` | `PATCH /products/{productId}`（带 `version`） |
| `fetchPackages` / `createPackage` | `GET\|POST /packages` |
| `fetchPackage` / `updatePackage` | `GET\|PATCH /packages/{packageId}` |
| `fetchPackagePriceVersions` / `createPackagePriceVersion` | `GET\|POST /packages/{packageId}/price-versions` |
| `transitionPackage` | `POST /packages/{packageId}/transition`（`activate`/`retire`） |
| `fetchFeatures` / `createFeature` | `GET\|POST /features` |
| `updateFeature` | `PATCH /features/{featureKey}` |

约定：

1. 价格版本只增不改（`package_price_versions` 仅 INSERT）：页面只提供「新增价格版本」，历史版本标记为只读快照，没有编辑/删除入口。
2. `featureKey` 不可变；`valueType` 被合同快照引用后不可改（409 `STATE_CONFLICT`）。
3. 套餐停用若被草拟合同引用 → 409 `OBJECT_REFERENCED`，文案由适配层统一映射，页面保留当前筛选与输入。
4. 金额按 `numeric(14,2)` 值域（0 – 999,999,999,999.99）校验，只格式化不换算。

## 页面

- `products.vue`：产品维护（列表、新建/编辑抽屉、销售方式勾选）。
- `plans.vue`：套餐列表（服务端分页 + 产品/销售方式/状态筛选），新建套餐抽屉。
- `plan-detail.vue`：套餐详情、价格版本历史（当前版本 vs 历史快照）、权益与状态迁移。
- `features.vue`：功能键目录（值的类型、启停、使用计数）。

## 开发态数据

`VITE_OPS_MOCK=true` 时走 `./mock` + `./fixtures`（3 个产品、5 个套餐、6 个功能键；`pkg-0001` 含 v1/v2 两个价格版本，`pkg-0002` 演示 `OBJECT_REFERENCED`），页面顶部固定「开发态数据」提示条。

## 契约推导待确认项

1. **`PackageStatus` 取值**：契约 §3.2 未枚举 `packages.status`，只在规则与错误码里出现 `retired`；当前按状态机反推为 `draft`/`active`/`retired`，需后端确认是否还有 `archived` 等取值（§2.6 未知枚举降级为 `未知(<raw>)`）。
2. **`PackagePriceVersion.id`**：`GET /packages/{id}/price-versions` 的 `items[]` 契约只列 `versionNo`，但合同条目需要 `priceVersionId`；当前 `id` 为可选，缺失时前端以 `versionNo` 兜底展示并按 `versionNo` 传参。
3. **`Package.version` / `ProductListItem.version`**：契约 §3.0 要求写操作回传 `version`，但列表/详情响应未列该字段；产品又没有独立详情端点，故列表必须下发 `version`（否则无法 `PATCH`）。
4. **`ProductListItem.description`**：同上，无详情端点，列表需带描述才能在编辑抽屉回填。
5. **`FeatureDefinition.usageCount`**：契约未定义统计口径（引用套餐数 / 生效合同数）；当前为后端下发的只读展示值。
6. **`PATCH /packages/{id}` 是否允许改挂牌价**：按「价格版本只增不改」，前端不提供改价入口（改价只能新增价格版本）；若后端允许 `PATCH` 改 `listPrice`，需要重新对齐。
