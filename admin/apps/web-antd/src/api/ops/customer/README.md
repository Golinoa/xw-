# customer 域（已实现）

契约：`Docs/ops-api-contract.md` §5.2（`/api/v1/ops/customers*`），数据模型 §3.1。页面：`src/views/ops/customer/`。

## 已实现端点

| 函数 | 方法与路径 |
| --- | --- |
| `fetchCustomers` | `GET /customers`（服务端分页/筛选/排序） |
| `createCustomer` | `POST /customers` |
| `checkCustomerDuplicate` | `POST /customers/duplicate-check` |
| `fetchCustomer` | `GET /customers/{customerId}` |
| `updateCustomer` | `PATCH /customers/{customerId}`（带 `version`） |
| `transitionCustomer` | `POST /customers/{customerId}/transition` |
| `fetchCustomerOverview` | `GET /customers/{customerId}/overview` |
| `fetchCustomerContacts` / `createCustomerContact` | `GET\|POST /customers/{customerId}/contacts` |
| `updateCustomerContact` / `deleteCustomerContact` | `PATCH\|DELETE /customers/{customerId}/contacts/{contactId}` |

约定：

1. 类型字段名逐字对齐契约，不虚构字段；金额 `numeric(14,2)` 在 JSON 里就是 `number`，前端只格式化不换算。
2. 列表筛选/分页/排序全部走服务端参数（`page`/`pageSize`/`sort`/`order`），不在浏览器里过滤全量数据。
3. 联系方式：`phoneMasked`/`emailMasked` 任何情况下都展示；`phone`/`email` 原值只在后端判定具备 `customer.sensitive.read` 时下发，前端不拼接、不反推。
4. 状态只能走 `/transition`（`start_onboarding`/`activate`/`suspend`/`resume`/`terminate`），不用 `PATCH` 改 `status`。

## 页面

- `list.vue`：服务端分页列表、关键词/状态/负责人筛选、排序、新建抽屉、停用二次确认（先取 `overview` + 详情拿 `version` 与影响摘要）。
- `detail.vue`：档案、状态迁移（终止需勾选确认）、联系人增删改、关联计数、错误条带 `requestId`。
- 公共组件 `ops-dev-data-notice` / `ops-permission-denied` / `ops-error-alert` 由本域提供，供三域复用。

## 开发态数据

`VITE_OPS_MOCK=true` 时走 `./mock`（内存 store，`./fixtures` 为虚构数据：`示例旅行社甲` 等 8 家，手机 `138****1234`、邮箱 `c***@example.invalid`），页面顶部固定展示「开发态数据」提示条。生产构建下 `import.meta.env.VITE_OPS_MOCK === 'true'` 为字面量假值，动态 `import()` 被 tree-shake。

## 契约推导待确认项

1. **`CustomerOverview` 列表元素形状**：契约只声明「合同/应收/订阅/授权/工单」概览，未给每条记录的字段；当前按各域列表的最小可见字段推导（`contractNo`/`status`/`totalAmount`…），缺字段时不渲染。
2. **`CustomerDetail.counts` 六个计数的下发方式**：现按 `contracts`/`deployments`/`licenses`/`receivables`/`subscriptions`/`tickets` 一次性下发，需确认是否改为按需查询。
3. **列表 `primaryContact`**：契约未说明列表是否带联系人。当前只在有掩码权限时返回 `{ maskedPhone, maskedEmail }`；无权限时应整体省略该字段而不是返回空对象。
4. **`transition.reason` 的必填范围**：契约只对 `suspend`/`resume`/`terminate` 标注需要原因，`start_onboarding`/`activate` 是否也必填待确认（页面按当前理解为选填）。
5. **`duplicateHints` 的键名**（`customerNo`/`id`/`name`/`reason`）：契约仅描述「重复提示、不自动合并」，键名为推导。
6. **`customerNo` 生成规则**：桩内为 `KH-YYYY-NNNNNN`，仅开发态占位，生产必须由后端生成。
