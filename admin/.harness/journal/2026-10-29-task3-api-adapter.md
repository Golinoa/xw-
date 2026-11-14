# 2026-10-29 Task 3：API 适配层与会话状态机（web-antd）

- 工作树：`D:/MYC/Coding/ERP-ops`，分支 `feat/ops-console`
- 范围：`admin/apps/web-antd` 的请求层与会话层（纯上游模板 → 真实运营后台适配层）
- 依赖：`Docs/ops-api-contract.md`（契约真源）、`.harness/docs/design-docs/2026-10-29-ops-shell-design.md`（§2.1/§2.2）、`src/constants/permissions.ts`（只读冻结）
- 协作边界：`src/router/**`、`src/views/**`、`src/layouts/**`、`src/preferences.ts` 由并行会话负责；本任务只改 `src/api/**`、`src/store/auth.ts` 与两份 `.env`

## 0. 结论速览

- demo 认证/请求层已替换为真实适配层：成功响应**业务 JSON 直出**（无 `{code:0,data}` 信封）、失败统一为 `OpsApiError`、每次请求带 `X-Request-Id`、401 单飞刷新后重放一次、4xx 不重试、5xx 指数退避最多 3 次。
- 会话状态机的每个分支都有明确落点（`authenticated`/`no_permission`/`no_membership`/`disabled`/`failed`/`network_error`/`expired`/`idle`），登出补齐了模板缺失的**动态路由重置**。
- `userInfo.accessCodes: OpsPermission[]` 已按硬约定落地，并在登录、`fetchUserInfo`、路由守卫复用的路径上都会回填到 `accessStore.accessCodes`。
- 后端 ops 模块尚不存在：`src/api/ops/__stub__/` 提供**显式标注**的开发态契约桩（默认关闭、生产 tree-shake、页面顶部黄色条幅）。
- 三条验收命令：`typecheck` ✅、`test:unit` ✅（63 条）、`lint:check` ❌（**唯一失败在冻结文件 `src/constants/permissions.ts`**，非本任务文件，详见 §5）。

## 1. 执行环境

| 项 | 值 |
| --- | --- |
| Node | `v24.20.0`（`export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"`） |
| pnpm | `10.33.4`（`corepack pnpm`） |
| 工作目录 | `D:/MYC/Coding/ERP-ops/admin` |
| 测试运行器 | `vitest 4.1.7`（`apps/web-antd` 无本地配置，走根目录默认 include） |

## 2. 改动清单

### 2.1 新增

| 文件 | 说明 |
| --- | --- |
| `src/api/adapter/env.ts` | 环境变量校验（同源/白名单、mock 开关、密钥扫描），非法配置启动即抛错 |
| `src/api/adapter/request-id.ts` | UUID v4 生成、`X-Request-Id` 读写、请求侧请求 ID 归一 |
| `src/api/adapter/request-meta.ts` | 请求级元数据（`requestId`/`retryCount`/`isRetryRequest`/`skipAuthRefresh`/`skipRetry`/`suppressErrorNotice`） |
| `src/api/adapter/errors.ts` | `OpsApiError`、错误码与 `details.reason` → 中文文案、可恢复性判定、成员失效归类、结构化日志 |
| `src/api/adapter/retry.ts` | 5xx/网络失败指数退避重试（只对幂等方法或带 `Idempotency-Key` 的请求） |
| `src/api/adapter/auth-refresh.ts` | 401 → 单飞刷新 → 重放一次；刷新网络失败不登出 |
| `src/api/adapter/notify.ts` | 全局错误提示出口（可注入，单测不加载 UI 库） |
| `src/api/ops/README.md` | 域目录约定 + 契约桩说明 + 待确认项清单 |
| `src/api/ops/index.ts`、`src/api/ops/identity/{index,session}.ts` | identity 域：`fetchOpsSession`/`fetchOpsMeta`/`fetchOpsPermissions` + 端点常量 + 类型 |
| `src/api/ops/__stub__/{index,fixtures,banner}.ts` | 开发态契约桩（虚构数据 + 顶部条幅） |
| `src/api/ops/{customer,catalog,contract,billing,entitlement,tenant,deployment,support}/README.md` | 空域占位：契约章节 + 待实现端点 + 实现约束 |
| `src/api/__tests__/env.test.ts` | 15 条：基地址校验、布尔开关、密钥扫描、生产 mock 断言 |
| `src/api/__tests__/request.test.ts` | 13 条：requestId 注入、4xx 不重试、5xx 重试上限、网络错误、401 刷新/重放/单飞/登录凭据错误 |
| `src/store/__tests__/auth-session.test.ts` | 10 条：登录成功/失败/无成员/停用/网络/零权限、登出清理、会话过期、`accessCodes` 透传 |
| `src/api/__tests__/stub-contract.test.ts` | 3 条：桩只接受 `stub/stub`、桩数据虚构、桩条幅确实挂到页面 |

### 2.2 修改

| 文件 | 改动 |
| --- | --- |
| `src/api/request.ts` | 重写拦截器链（头处理 → body 直出 → 401 刷新 → 重试 → 错误映射）；删除 `defaultResponseInterceptor` 信封假设；`Bearer null` 已修 |
| `src/api/core/auth.ts` | 登录/刷新/登出对接 `/v1/ops/auth/*`（raw client + `withCredentials`），删除已无契约依据的 `/auth/codes` |
| `src/api/core/user.ts` | `getUserInfoApi()` 改为消费 `GET /v1/ops/session`，映射为 `OpsUserInfo`（含 `accessCodes`） |
| `src/api/core/menu.ts` | 契约无菜单端点：保留导出但显式抛错（避免静默返回空菜单） |
| `src/store/auth.ts` | 会话状态机重写；登出补 `resetRoutes()`；`markSessionExpired()`；失败抛 `OpsApiError` 供登录页内联呈现 |
| `.env.development` | `VITE_NITRO_MOCK=false`、新增 `VITE_OPS_MOCK=false`、`VITE_OPS_API_PREFIX=/v1/ops`、`VITE_OPS_API_ALLOWED_ORIGINS=` |
| `.env.production` | 同上（`VITE_OPS_MOCK=false`、`VITE_NITRO_MOCK=false`），基地址保持 `/api` |

## 3. 关键决策

1. **响应解包用 `responseReturn: 'body'` + 自有 unwrap 拦截器**，不要求后端加信封。`RequestClient.request` 的 `throw error.response.data` 会丢状态码，因此错误映射放在**最后一个** rejected 拦截器，抛出的 `OpsApiError` 不带 `response` 字段，原样穿透。
2. **错误文案只按 `code` + `details.reason` 映射**（契约 §6），绝不展示后端 `message`；`requestId` 附在 `displayMessage` 里供运营反馈。
3. **重试只对幂等方法或带 `Idempotency-Key` 的写请求**。5xx 无限重放 `POST /receipts` 会重复登记，契约 §2.5 要求写操作带幂等键才安全。
4. **401 单飞刷新用闭包内 `inFlight` 自己实现**，没有使用 `@vben/request` 的 `authenticateResponseInterceptor`：内置实现遇到刷新网络失败会直接 `doReAuthenticate()`，与"网络失败不登出"冲突。
5. **请求元数据挂在 `config.__opsMeta`**（`src/api/adapter/request-meta.ts`），而不是做 `axios` 模块增强：`apps/web-antd` 未直接依赖 `axios`（`axios` 只能从 `@vben/request` 转出），模块增强会编译失败；且 axios 对未知键走 `mergeDeepProperties`，元数据在重放/重试中会保留。
6. **登录失败抛异常而不是返回错误对象**：并行会话的登录页在 `handleSubmit` 里 `catch` 后用 `classifyLoginError()` 渲染内联提示（他们明确要求"不用全局 toast"），因此登录端点错误抑制全局提示。
7. **零动作码视为登录失败**：没有 `accessCodes` 时任何页面都进不去，保留会话只会产生"登录成功但一片空白"，故清会话 + 抛 `FORBIDDEN`（可被归到 `no-permission`）。
8. **契约桩用字面量比较 `import.meta.env.VITE_OPS_MOCK === 'true'`**：写成函数调用会阻止 tree-shake；字面量比较才能让生产构建把 `__stub__` 与动态 import 一起摇掉。
9. **`logout` 用动态 `import('#/router')` 调 `resetRoutes()`**：`src/router` 反向依赖 `#/store`，静态导入会形成初始化循环。
10. **token 只从内存 store 读**：`request.ts` 不再写 `Bearer null`，不读 localStorage、不进 URL；刷新令牌只通过 `withCredentials` 携带 HttpOnly Cookie。

## 4. 命令与实测结果

```bash
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH" && cd "D:/MYC/Coding/ERP-ops/admin"

corepack pnpm --filter @vben/web-antd typecheck     # ✅ exit 0，无输出
corepack pnpm --filter @vben/web-antd test:unit     # ✅ 9 files / 63 tests passed
corepack pnpm run lint:check                        # ❌ 仅 src/constants/permissions.ts（冻结文件）5 条 sort-sets
```

`test:unit` 明细：`env.test.ts` 15、`request.test.ts` 13、`auth-session.test.ts` 10、`stub-contract.test.ts` 3、并行会话的 `router/__tests__` 5 个文件 22 条，合计 63 条全绿。

```
Test Files  9 passed (9)
     Tests  63 passed (63)
```

`lint:check` 实测：

- oxlint：`Found 0 warnings and 0 errors`（98 files）；
- eslint：本任务文件 `apps/web-antd/src/api`、`apps/web-antd/src/store` 单独跑 `eslint` **exit 0**；全量跑只剩 5 条，全部在冻结文件里：

```
src/constants/permissions.ts
   93:3  error  Expected "OPS_PERMISSION.RECEIPT_REFUND" to come before "OPS_PERMISSION.RECEIPT_REVERSE"      perfectionist/sort-sets
   94:3  error  Expected "OPS_PERMISSION.ENTITLEMENT_APPROVE" to come before "OPS_PERMISSION.RECEIPT_REFUND"  perfectionist/sort-sets
   98:3  error  Expected "OPS_PERMISSION.TENANT_RESTORE" to come before "OPS_PERMISSION.TENANT_SUSPEND"       perfectionist/sort-sets
  100:3  error  Expected "OPS_PERMISSION.OPERATOR_MANAGE" to come before "OPS_PERMISSION.TENANT_RETRY"        perfectionist/sort-sets
  102:3  error  Expected "OPS_PERMISSION.EXPORT_CREATE" to come before "OPS_PERMISSION.ROLE_MANAGE"           perfectionist/sort-sets
```

（该文件 `git status` 为未跟踪的新文件，作者是并行会话，本会话全程只 `import` 未写入。）

## 5. 未完成项与依赖

1. **`src/constants/permissions.ts` lint 违规**：该文件在本任务边界里是"只读冻结"，且由并行会话（Task 3 权限壳）维护，本会话**未改动**。修复成本极小，任一方执行一次即可： `corepack pnpm exec eslint apps/web-antd/src/constants/permissions.ts --fix`（纯元素重排，无语义变化）。并行会话的 journal（`2026-10-29-task3-permission-shell.md`）已把同一问题登记为待 leader 决策项。
2. **ops 业务域客户端未实现**：只有 identity 域落地，其余 8 域按任务要求留 `README`。后端就绪后逐域补 `index.ts`。
3. **契约桩只覆盖 identity**：客户/合同/账款等域尚无桩，因为契约字段虽已定义但对应页面未实现，提前造桩会制造"假集成"。
4. **未补 `/auth/no-access` 落地页**：`src/router/**` 属并行会话，本会话只在状态机里暴露 `no_permission`，跳转由路由负责人接。
5. **单测未使用 `@vue/test-utils`**：本任务被测对象是请求内核与 Pinia 状态机，没有组件挂载需求；边界 mock 只替换 axios adapter、路由实例与提示出口，比挂载组件更贴近真实链路。

## 6. 待后端确认（前端已按契约推导，后端可改，前端只是常量）

| 项 | 当前取值 | 依据 |
| --- | --- | --- |
| 认证端点路径 | `/v1/ops/auth/{login,refresh,logout}` | 契约 §5.1 **未定义**认证端点；取自设计文档 §2.2 |
| 登录/刷新响应体 | `{ accessToken }` | 契约未定义；假定刷新令牌走 `Set-Cookie`（HttpOnly、轮换） |
| `operator.status` 枚举 | `active` / `invited` / `disabled` | 契约 §5.1 只出现 `invited`，其余由 §6.4 的 `OPS_MEMBER_INACTIVE` 反推 |
| 菜单来源 | 前端静态路由 + 动作码过滤 | 契约无菜单端点；`getAllMenusApi()` 保留但显式抛错 |
| `contractVersion` 不兼容处置 | 已实现 `fetchOpsMeta()`，但**暂不阻断** | 等后端给出真实版本号与语义（v1 内加法兼容） |

## 7. 风险

- **R1（高）access token 仍会被 `@vben/stores` 持久化到 localStorage**：设计 §2.1.8 要求从 `packages/stores/src/modules/access.ts` 的 `persist.pick` 删除 `accessToken`/`refreshToken`，这属于上游共享包补丁，**不在本任务可写边界内**。本会话只能保证"请求侧不读 localStorage、不写 URL"，无法阻止 pinia 持久化插件落盘。需要 leader 指派一次上游补丁（一行改动）。
- **R2（中）`src/constants/permissions.ts` 的 lint 违规**：见 §5.1。冻结与"lint 必须绿"两条约束互斥，需 leader 一句话裁决。
- **R3（中）登录页的停用态归类**：并行会话的 `classifyLoginError()` 只读 `code`/`status`/`kind`，不读 `details.reason`，因此 `OPS_MEMBER_INACTIVE` 会被归到"无运营权限"而不是"账号停用"。适配层已把 `reason` 放在 `OpsApiError.reason` 上，建议登录页补一行判断（不改也能用）。
