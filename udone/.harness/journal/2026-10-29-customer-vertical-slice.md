# 2026-10-29 客户主数据垂直切片

## 今日完成

- 客户域从契约到前端打通，分三次提交（分支 `feat/business-slice`）：
  - `cf8c265` feat(udone): customer master data vertical slice
  - `517e297` fix(udone): contract and api-client defects found by the customer UI
  - `92c6549` feat(udone): customer list, form and detail UI
- 契约：新增 `pagination.ts`（分页/排序白名单，落实 `CONTRACTS.md` §9.4 遗留项）、
  `customers.ts`（列表/详情/创建/更新/标签 DTO）；`permissions.ts` 新增
  `customer.read` / `customer.write` / `customer.sensitive.read`；`errors.ts` 新增
  `NOT_FOUND` / `OBJECT_REFERENCED` / `TENANT_SCOPE_DENIED`。`ROUTES` 注册 7 个端点。
- 数据库：`20261029000001_customer_domain.sql` 新建 customers、customer_sources、
  customer_tags、customer_tag_links 四表，全部使用 `(业务列, organization_id)` 复合外键；
  RLS 同时校验功能权限与 own/all 数据范围；`create_customer_with_tags` 把客户与标签
  关联收进同一事务。`schema:generate` 已重生成，报告覆盖 6 个 migration。
- API：`apps/api/src/modules/customers/` 分仓储 / 服务规则 / 路由三层；列表分页用
  `restPage()` 读 `Content-Range` 取 total；电话与证件号按 `customer.sensitive.read`
  决定是否返回原值；更新用 `version` 乐观锁。
- 前端：`/customers` 列表、表单弹窗、详情抽屉；筛选与分页同步 URL；四种状态分开渲染。
- 测试：136 → 157（掩码纯函数、分页边界、权限拒绝、跨租户 404、版本冲突、非法标签、
  null 清空、显式回传默认 pageSize）。

## 关键决策

- **进度口径**：用「需求条目落地数 / 需求条目总数」和「工程任务勾选」两个可核实指标，
  不用主观百分比。
- **分页契约一次定死**：`page`/`pageSize`/`sort`/`order`，默认 15、可选 15/10/20/30/50/100。
  15 必须留在白名单里，否则客户端回传自己的默认值会被自己的校验拒绝。
  `sort` 只能是白名单枚举，因为 PostgREST 的 `order` 位于标识符位置，无法参数化绑定。
- **可空语义分两种**：`undefined`/缺失 = 不修改，`null` = 清空。之前只有「缺失」一种表达，
  用户填错的手机号永远删不掉。`tagIds` 仍用空数组表达「清空全部标签」。
- **掩码放在 API 层而不是列权限**：PostgreSQL 列级权限是角色级的（`authenticated` 是统一
  角色），无法按租户内角色区分可读列；直连 PostgREST 需要 anon key，而该 key 只在 Worker
  secrets 中、不进前端产物，因此绕过 API 读原值的前提不成立。此限制已写进 migration 注释。
- **创建走 RPC，更新不走**：创建需要「客户行 + 标签关联」原子完成，否则重试会造重复客户；
  更新是单表 PATCH 加一次标签重写，失败可重试修复，不值得再引入一个事务函数。
- **删客户用软删除**：历史订单仍会引用客户快照，`authenticated` 不授予物理 DELETE。
- 提交按「基础设施修复 / 功能实现」拆开，避免一个提交里既有契约变更又有 600 行 UI。

## 遇到的问题

- **api-client 两个既有缺陷**（由前端实现暴露，已修）：
  1. GET 路由从不发送查询参数——`body` 被塞进 GET 请求，浏览器直接抛错；
  2. `request` schema 一律拿去校验 `body`，导致 `getCustomer` / `deleteCustomer`
     这类「request 描述路径参数」的路由永远抛 `ContractViolationError`。
- **权限是表驱动的**：`organization_role_permissions` + `has_permission()` 从表读，
  新权限只需 INSERT，不需要改函数。这一点与 `rls_helpers.sql` 的旧硬编码版本不同，
  改动前必须先看最新 migration。
- **`CustomerPhoneConflictError` 是错误命名**：手机号刻意不唯一，重复只提示不阻断，
  该错误实际来自标签关联主键等约束，已改为 `CustomerConflictError`。
- **数据库门禁未验证**：本机无 Supabase CLI、无 Docker（且 WSL 被安全策略拦截），
  `pnpm db:test`（pgTAP）与空库迁移重放**没有执行**。新增的 RLS 策略、复合外键、
  `create_customer_with_tags` 的 SQL 语法与运行时行为均未在真实 PostgreSQL 上验证过，
  只做了 `format:sql:check` 与 `schema:check`。这是当前最大风险，不能当作已验收。
- `.vue` 文件没有类型级检查（项目未装 `vue-tsc`），SFC 只经过 ESLint 解析与 `vite build`。

## 验证记录（2026-10-29，本机）

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | 通过（web + api） |
| `pnpm test` | 30 文件 / 157 测试通过 |
| `pnpm lint` | 通过 |
| `pnpm format:check` | 通过 |
| `pnpm format:sql:check` | 通过（11 个 SQL 文件） |
| `pnpm schema:check` | 通过（6 个 migration） |
| `pnpm build` | 通过；主包 1.6 MB 告警为既有问题，客户页独立 chunk 19.5 kB |
| `pnpm db:test` | **未执行**（无 Supabase CLI / Docker） |

## 下一步计划

- 订单域（R-ORDER-01/02/03）：订单号租户内唯一、服务端重算金额与利润、
  创建走事务函数、状态机 booking/active/completed/cancelled。
- 应收应付项目随订单创建生成，查询与汇总端点随后补。
- 客户回收站与恢复（当前只有软删除，没有恢复入口）。
- 客户来源（customer_sources）维护端点与 UI 下拉，目前表已建、无 API。
- 在具备 Docker 或 Supabase CLI 的环境补跑 pgTAP，并把这些用例保留为「未验证」状态
  直到真实数据库证据到位。
