# 运营端客户与联系人：S2 契约 + S3 端点（o-t04）

## 今日完成

- 新增 `packages/contracts/src/ops/customers.ts`：客户/联系人/列表项/六个请求/十个响应
  schema 与类型。联系人敏感字段用**两个 strictObject + union**（原值键存在 vs 不存在），
  不用 `optional()`。
- `packages/contracts/src/ops/index.ts` 追加 `export * from './customers';`
  （保留并行会话的 `audit-actions`）。
- `packages/contracts/src/routes.ts` 的 `OPS_ROUTES` 末尾登记 11 条（listOpsCustomers …
  deleteOpsCustomerContact），结构与 `as const satisfies Record<string, RouteContract>` 不变。
- 新增 `apps/api/src/modules/ops/customers/{protocol.ts,routes.ts,routes.test.ts}`：
  RPC helper（与 accounts 同构的第二份）、11 个 handler、信封 zod、错误映射；
  `apps/api/src/index.ts` 在 `opsAccountRoutes` 之后挂载。
- 单测 38 例：11 条端点各有 2xx 与拒绝用例，含「无权限时 phone/email 键不存在」
  与「half-masked 形状 503」两条 P6 断言。

## 关键决策

- **RPC 键名一律 snake_case**（含嵌套 `primary_contact.masked_phone`、
  `owner.display_name`），与既有 `ops.list_operators` 等函数的 `jsonb_build_object`
  口径一致；出站映射在 protocol.ts。入站 `p_contacts` 的元素键也用 snake_case
  （`job_title`/`is_primary`/`usage_scene`）。
- `status` 与 `ownerOperatorId` 不在 PATCH 白名单：状态走 transition；责任人本轮
  **没有**写入口（§5.2 未给），未自创字段。
- 三个写端点（create / transition / create contact）在 handler 里显式校验
  `Idempotency-Key`：全局中间件对缺键请求直接放行，拦不住。
- `status` 筛选读 `context.req.queries()`（`req.query()` 只留第一个值），因此客户列表
  自己解析 query，错误形状与 `lib/contract.ts` 的 `parseQuery` 一致；未改公共函数。
- `contractStatus` 只校验形态（≤32），不定义枚举：合同状态属 contract 域（T-06），
  在这里定义会造第二真源。
- 联系人长度上限（200/120/32/200）契约未给，按同域口径取值并在报告里标注待确认。
- DELETE 联系人按约定 RPC 需要 `p_reason`，但契约的 DELETE 行没有 reason 入口，
  如实传 `null`，不自造审计文案。

## 遇到的问题

- `req.query()` 对重复参数只保留第一个，`?status=a&status=b` 会静默只筛一半；
  已在客户列表用 `req.queries()` 拼回数组。
- 总览的七个摘要数组元素只能是 `z.record(...)`：`z.array(z.unknown())` 推不出契约里的
  `Record<string, unknown>[]`，且无法拒绝 `null` 元素。
- §6.4 的 `details.reason` 词表里**没有** `INVALID_TRANSITION` / `CONTACTS_REQUIRED` /
  `LAST_PRIMARY_CONTACT`，这三个值是本轮先用的，需与主会话对齐（未改 `errors.ts`）。

## 下一步计划

- S1 迁移落地后补 `tests/integration/ops-customer.test.ts`（本轮按要求未写）。
- 主会话确认：RPC 键名大小写、`p_contacts` 元素键名、DELETE 的 reason 缺口、
  §6.4 三个 reason 词、列表项是否照 §5.2 收窄。
