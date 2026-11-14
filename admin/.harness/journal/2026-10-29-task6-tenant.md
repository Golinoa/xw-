# Task 6 前端 · tenant-integration 域交付记录

- 日期：2026-10-29
- 分支：`feat/ops-console`，工作树 `D:/MYC/Coding/ERP-ops`
- 范围：仅前端（`apps/web-antd`），未触碰 `udone/`、`ERP/`、`_refs/`
- 前置门禁：`.harness/journal/2026-10-29-source-gate-task6-7.md` 已读，§3.1 / §3.3 / §3.5 / §5 为本次硬约束

## 1. 交付清单

新增（API，`apps/web-antd/src/api/ops/tenant/`）：
`types.ts`、`endpoints.ts`、`idempotency.ts`、`mappings.ts`、`commands.ts`、`errors.ts`、`rules.ts`、`format.ts`、`fixtures.ts`、`dev-stub.ts`、`index.ts`，并更新 `README.md`。

新增/替换（视图，`apps/web-antd/src/views/ops/tenant-integration/`）：
`mappings.vue`（替换占位页）、`commands.vue`、`command-feedback.ts`、
`composables/use-command-submission.ts`、
`components/command-form-modal.vue`、`components/command-detail-drawer.vue`、`components/mapping-detail-drawer.vue`。

路由：`src/router/routes/modules/tenant-integration.ts` 新增 `/tenants/commands`（`TenantCommands`）。

单测（`views/ops/tenant-integration/__tests__/`）：
`command-submission.test.ts`、`tenant-rules.test.ts`、`tenant-errors.test.ts`、
`command-feedback.test.ts`、`tenant-dev-stub.test.ts`、`command-detail-drawer.test.ts`、
`mapping-detail-drawer.test.ts`（共 49 例）。

## 2. 幂等与版本冲突落点

| 约束 | 落点 |
| --- | --- |
| 幂等键只生成一次 | `api/ops/tenant/idempotency.ts:createCommandIdempotencyKey()`，由 `views/.../composables/use-command-submission.ts:openForm()` 调用一次并存入 `idempotencyKey` ref；`submit()` 与失败重试都读同一个 ref，`submitting` 期间重复点击直接返回 |
| 写请求透传键 | `api/ops/tenant/commands.ts:createCommand(mappingId, input, idempotencyKey)` → `endpoints.ts:writeConfig()`；`retryCommand()` 强制复用 `command.idempotencyKey`，缺失时抛错不发请求 |
| 映射创建也幂等 | `api/ops/tenant/mappings.ts:createMapping()` / `updateMapping()` 接收表单持有的键，`mappings.vue:openCreate()` 打开弹窗时生成 |
| `expected_sync_version` 必传 | `api/ops/tenant/rules.ts:composeCommandInput()`：`null/undefined/非整数/负数` 一律拒绝（`version_missing`），页面在 `mapping-detail-drawer.vue:requestCommand()` 直接取 `mapping.syncVersion` |
| 版本冲突刷新 | `errors.ts:describeTenantError()` 对 `STATE_CONFLICT + SYNC_VERSION_CONFLICT` 返回 `shouldRefresh=true`；`mapping-detail-drawer.vue:onCommandSubmit()` 与 `command-detail-drawer.vue` 在失败后 `load()` 重拉服务端数据，**不做本地 syncVersion 覆盖** |
| 永久错误禁止重试 | `rules.ts:canRetryCommand()`（`permanent_error` 优先判定）+ `errors.ts` 的 `PERMANENT_ERROR` 分支；页面按钮 `disabled` 并给出 `tenant-retry-blocked` 说明 |

## 3. 「失败不得装成成功」的实现保证

1. `createCommand()` 只返回 `TenantCommandAccepted`（命令 id / status / 幂等键），不返回「成功」语义；
   文案由 `command-feedback.ts:describeAcceptedCommand()` 统一生成，前缀固定「已受理，结果待确认」。
2. 502 `SYNC_TARGET_UNAVAILABLE` 映射为 `kind='accepted'`（契约 §6.3：命令仍 pending），
   不会被渲染成失败，也不会被渲染成成功。
3. 重试（202）同样只显示「已受理」；命令状态以服务端 `fetchCommand()` 返回为准，页面不本地推进状态。
4. 命令详情以服务端 `attempts[]` 原文渲染，页面无任何写入尝试记录的入口（契约：仅 INSERT）。
5. 永久性错误在 UI 上有独立红色提示块（`tenant-permanent-error`），并说明「运营侧状态未被标记为成功」。

## 4. 状态覆盖

| 状态 | 落点 |
| --- | --- |
| loading | `Table :loading`、`Drawer` 内 `Spin` |
| empty | `Table #emptyText`（映射 / 命令 / 尝试记录三处空态文案不同） |
| error | `tenant-list-error`、`tenant-command-list-error`、`tenant-mapping-error`、`tenant-command-error`（含 requestId + 重试） |
| validation | 新建映射 / 下发命令 / 重试 / 取消的字段级错误（原因必填、客户/产品必填、同步版本缺失） |
| permission-denied | 页面级 `tenant.read` 拦截（不渲染任何数据）；命令入口按动作码显隐；命令列表无 `tenant.read` 时同样整页拦截 |
| conflict | `TENANT_MAPPING_CONFLICT`（不自动改绑、无改绑按钮）/ `SYNC_VERSION_CONFLICT`（刷新重拉）/ `PERMANENT_ERROR` / `APPROVAL_REQUIRED` / `IDEMPOTENCY_CONFLICT` |
| destructive-confirm | 取消命令（danger 确认 + 原因必填）、暂停/撤销等高风险命令（`isHighRiskPermission()` 派生，勾选确认 + 原因必填） |

## 5. 开发态数据（诚实隔离）

- `fixtures.ts`：四家「示例旅行社甲/乙/丙/丁（虚构）」、虚构 `udone_organization_id`（`0f0e…` 段）、虚构产品 ID；
  无任何真实租户信息。
- `dev-stub.ts`：静态 `VITE_OPS_MOCK === 'true'` 判定 + 动态 `import()`（与 billing 一致，生产可摇树）。
- 四种可演示状态：成功（`TC-2026-000501`）、transient 可重试（`…0502`，2 次尝试含 timeout）、
  permanent 不可重试（`…0503`）、版本冲突（映射 `TM-2026-000404`，桩在首次下发前推进 `syncVersion` 复现 409）。
- 页面复用 `views/ops/billing/components/dev-data-notice.vue`（只读引用），提示「开发态数据、未集成、不可决策」。

## 6. 验证结果（真实输出）

本工作树同时有多个并行任务在编辑**其它域**（`contract` / `customer` / `entitlement` 目录均为 `??` 未跟踪状态，
2026-10-29 23:13 仍在写入），全仓门禁的观测值会随他人保存而抖动。最终一轮（23:20 前后）：

```
corepack pnpm --filter @vben/web-antd typecheck   → 通过（vue-tsc 无输出，exit 0）
corepack pnpm --filter @vben/web-antd test:unit   → 37 files / 265 tests 全部通过（含本域 7 files / 49 tests）
corepack pnpm run lint:check                      → 失败：eslint 9 处，全部在本任务范围之外：
                                                    adapter/request-id.ts(2) unicorn/number-literal-case
                                                    api/ops/billing/dev-stub.ts(1) unicorn/no-nested-ternary
                                                    views/ops/catalog/plan-detail.vue(2)
                                                    views/ops/contract/detail.vue(2)
                                                    views/ops/customer/list.vue(2)（均为 vue/html-closing-bracket-newline）
                                                    oxlint 阶段 0 error / 0 warning
corepack pnpm run format:check                    → 通过（1147 files，All matched files use the correct format）
本域单独校验：oxlint 0 error（25 files）、eslint 0 error、oxfmt --check 通过
```

## 7. 需要 leader 处理的跨域阻塞

工作树里 `views/ops/{catalog,contract,customer,entitlement}/**`、`api/ops/{billing,entitlement}/**`、
`api/adapter/request-id.ts` 等均为**本分支尚未提交的并行任务产物**（`git status` 显示 `??` 或在基线里已修改），
不属于本任务可写范围。当前 `lint:check` 的 9 处失败**全部来自这些文件**：

- `vue/html-closing-bracket-newline`（6 处）：catalog/plan-detail.vue、contract/detail.vue、customer/list.vue；
- `unicorn/number-literal-case`（2 处）：api/adapter/request-id.ts（`0x0f` / `0x3f` 小写十六进制）；
- `unicorn/no-nested-ternary`（1 处）：api/ops/billing/dev-stub.ts:215。

这些是**基线既有问题**：此前 `lint:check` 的 `&&` 链在 oxlint 阶段就被其它错误打断，eslint 根本没跑到，
因此从未暴露。本任务未修改上述文件，也无法在授权路径内修复。建议：由对应域负责人各跑一次
`eslint --fix`（前 6 处可自动修复），request-id / billing 的两处需手工改，然后再统一跑四条门禁。

## 8. 契约推导 · 待确认项

1. **`SYNC_VERSION_CONFLICT` 是否进入 `details.reason` 词表**：契约 §6.4 无此 reason；
   `GET/POST tenant-mappings` 的 409 只列 `TENANT_MAPPING_CONFLICT`，命令下发的 409 写的是
   `STATE_CONFLICT`（`expectedSyncVersion` 过期）。前端按「`STATE_CONFLICT` + `SYNC_VERSION_CONFLICT`」处理，
   并同时兜底任意 409（刷新 + 提示）。**需后端确认**：要么把该 reason 补进 §6.4，要么明确用 `STATE_CONFLICT` 无 reason。
   桩按前端假设返回该 reason，若后端定稿不同只需改 `dev-stub.ts`。
2. **202 响应体两种形态**：§2.4 写 `{commandId,status,idempotencyKey}`，§5.7 写 `command{id,commandNo,status}`。
   `commands.ts:normalizeAccepted()` 同时兼容；`status` 缺省按 `pending`，绝不默认成功。
3. **`GET /tenant-mappings` 是否支持 `syncVersion` 筛选**：§5.7 未列该参数，但交付需求要求按同步版本筛选。
   前端按字面发送，后端未实现时应忽略。**需确认**是否允许该参数进入白名单。
4. **`GET /tenant-commands` 的 `status[]` 序列化**：按字面 `status[]=a&status[]=b` 发送（与 billing 同口径），
   需后端确认租户命令端点接受该形态。
5. **取消的权限判定**：契约写「原命令动作」，即按 `commandType` 映射动作码。前端用
   `rules.ts:commandPermission()` 判定，需要后端在 `cancel` 上执行同一映射（而非固定 `tenant.retry`）。
6. **`attempts` 的 `finishedAt` 是否可能为空**：timeout 场景契约未写清，前端按可空渲染（`—`）。
7. **语言包**：`/tenants/commands` 的 `meta.title` 为字面量「命令与尝试记录」，
   因 `src/locales/**` 不在本任务可写范围；后续应补 `ops-shell.menu.tenantCommands` 并改回 `$t()`。

## 9. 风险（≤3）

1. **202 语义被误读为成功**：已在类型层（`TenantCommandAccepted` 非 `TenantCommand`）+ 文案层（唯一生成器）+
   页面层（信息色 Alert 而非 `message.success`）三重约束；但后续新增页面若绕过 `command-feedback.ts` 自行拼文案，
   仍可能回退。建议 code review 检查项：禁止在 tenant 域出现 `message.success('...已下发')`。
2. **幂等键生命周期依赖表单**：`use-command-submission` 保证「一次意图一个键」，但映射新建页是独立实现
   （`mappings.vue` 内联），两处逻辑同构但未共用。若后续再加写入口，应抽公共 composable，否则容易退化成「提交时生成」。
3. **契约未定稿的 reason 会影响联调**：`SYNC_VERSION_CONFLICT` 目前是前端推导值。若后端最终用其它 reason
   （或复用 `CONFLICT` 无 reason），页面仍会刷新并提示，但文案会退化为通用「状态冲突」，不会误判为成功。
