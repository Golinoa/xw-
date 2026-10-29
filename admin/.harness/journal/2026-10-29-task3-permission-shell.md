# 2026-10-29 Task 3：权限驱动路由、运营导航壳与登录/拒绝页

- 工作树：`D:/MYC/Coding/ERP-ops`，分支 `feat/ops-console`
- 范围：`admin/apps/web-antd`（Vben v5.7.0 纯净模板 → 真实运营后台应用壳）
- 依赖：`src/constants/permissions.ts`（只读冻结）、`src/store/auth.ts` 的 `userInfo.accessCodes`（并行专家实现）
- 需求真源：`Docs/PRD.md` §4/§5、`.harness/docs/design-docs/2026-10-29-ops-shell-design.md`、`.harness/FRONTEND.md`

## 1. 改动清单

### 1.1 新增

| 文件 | 说明 |
| --- | --- |
| `src/router/routes/modules/identity-audit.ts` | 运营总览 `/overview`、运营配置 `/governance/*`、审计与集成 `/audit/*`（共 5 页 / 3 个一级入口） |
| `src/router/routes/modules/customer.ts` | 客户管理 `/customers/list` |
| `src/router/routes/modules/catalog.ts` | 产品目录、套餐与价格 |
| `src/router/routes/modules/contract.ts` | 合同列表 |
| `src/router/routes/modules/billing.ts` | 应收计划、收款与核销 |
| `src/router/routes/modules/entitlement.ts` | SaaS 订阅、授权与权益 |
| `src/router/routes/modules/tenant-integration.ts` | 租户映射与开通 |
| `src/router/routes/modules/deployment.ts` | 部署实例 |
| `src/router/routes/modules/support.ts` | 工单列表 |
| `src/router/routes/modules/account.ts` | `/profile`（`hideInMenu`，顶栏用户下拉入口，无动作码） |
| `src/views/ops/_shared/placeholder-page.vue` | 占位页模板：标题 + 「待实现」+ 所需动作码 + 「菜单隐藏不是授权」提示 |
| `src/views/ops/_shared/use-ops-permission.ts` | `useOpsPermission()` → `hasPermission(code)` / `hasAnyPermission(codes)` / `grantedCodes` |
| `src/views/ops/<domain>/*.vue` | 16 个域占位页（identity-audit 5、customer 1、catalog 2、contract 1、billing 2、entitlement 2、tenant-integration 1、deployment 1、support 1） |
| `src/views/_core/authentication/login-error.ts` | 登录失败归类（凭据错误/停用/无权限/网络/限流/5xx/未知） |
| `src/locales/langs/zh-CN/ops-shell.json`、`en-US/ops-shell.json` | 命名空间 `ops-shell`：菜单、登录、403/404、占位页文案 |
| `src/router/__tests__/{test-utils,route-authority,menu-from-access-codes,unauthorized-404,access-generation,guard-access-codes}.test.ts` | 5 个用例文件 / 22 条断言 |

### 1.2 修改

| 文件 | 改动 |
| --- | --- |
| `src/router/guard.ts` | **核心改造**：路由生成改传动作码；新增 `resolveAccessCodes()`；补 404 口径注释 |
| `src/router/access.ts` | 入参由 `roles` 改为显式 `accessCodes`；删除 `fetchMenuListAsync` 死代码与 `getAllMenusApi` 依赖；新增 `resetAccessRoutes()` |
| `src/router/index.ts` | `resetRoutes` 改用 `resetAccessRoutes`（修复跨账号路由残留） |
| `src/router/routes/core.ts` | 删除 4 条演示 auth 子路由（register/code-login/qrcode-login/forget-password）；新增 `/error/403`（`ignoreAccess`）；404 注释明确「不存在或无访问权限」 |
| `src/views/_core/authentication/login.vue` | 重写为运营登录：账号+密码、无演示账号/滑块、关闭注册/验证码/二维码/找回密码/第三方登录；表单上方内联错误提示 |
| `src/views/_core/fallback/not-found.vue` | 404 页改为自定义文案「页面不存在或无权访问」 |
| `src/views/_core/fallback/forbidden.vue` | 403 页改为自定义文案「无访问权限」 |
| `src/preferences.ts` | `accessMode: 'frontend'`、`defaultHomePath: '/overview'`、`widget.notification: false` |
| `src/layouts/basic.vue` | 删除 6 条伪造通知与 Vben 文档/GitHub/问答外链；用户下拉改用 `realName`/`username`，去掉假邮箱与 `Pro` 标签 |

### 1.3 删除

- `src/router/routes/modules/{dashboard,demos,vben}.ts`
- `src/views/_core/authentication/{register,code-login,qrcode-login,forget-password}.vue`

> 说明：`src/views/dashboard/**`、`src/views/demos/**`、`src/views/_core/about/**` 目录仍在（不在本任务可写范围），已无路由引用，只会被 `access.ts` 的 `pageMap` glob 收集，不进入菜单。

## 2. 权限机制改造点（前后差异）

### 2.1 原错误代码位置

改造前 `src/router/guard.ts:93-104`：

```ts
// 生成路由表
// 当前登录用户拥有的角色标识列表
const userInfo = userStore.userInfo || (await authStore.fetchUserInfo());
const userRoles = userInfo.roles ?? []; // ← 错误：把角色名当授权集合

const { accessibleMenus, accessibleRoutes } = await generateAccess({
  roles: userRoles, // ← 错误：meta.authority 与角色名求交集
  router,
  routes: accessRoutes,
});
```

上游 `generateRoutesByFrontend` 用 `access.some(v => authority.includes(v))` 求交集（`packages/utils/src/helpers/generate-routes-frontend.ts:36-44`）。因此路由上写 `authority: ['receipt.approve']` 时，该值永远不可能出现在 `roles` 里 → 路由恒定被剔除/403。

### 2.2 改造后

| 层 | 机制 | 位置 |
| --- | --- | --- |
| 路由 | `meta.authority` 写**动作码**（`OPS_PERMISSION`），OR 语义；父级取子级并集，无权时整棵子树消失 | `src/router/routes/modules/*.ts` |
| 守卫 | `resolveAccessCodes(accessStore.accessCodes, userInfo)`：优先 store，回退 `userInfo.accessCodes`，**绝不读 `roles`**；生成路由时以 `accessCodes` 作为上游 `roles` 实参 | `src/router/guard.ts:19-40,132-160` |
| 菜单 | 无独立声明，由过滤后的路由树派生（`generateMenus`） | `src/router/access.ts` |
| 按钮/区块 | `v-access:code="'receipt.approve'"`（沿用上游指令）+ `useOpsPermission().hasPermission()` | `src/views/ops/_shared/use-ops-permission.ts` |
| 拒绝口径 | 无权路由不注册 → 直达 URL 命中 `/:path(.*)*` → 404 文案含「不存在或无权访问」；403 页保留给需要「功能存在但无权限」明示的模块（`menuVisibleWithForbidden`，本阶段未启用） | `src/router/routes/core.ts`、`src/views/_core/fallback/*` |

附带修复（跨账号泄漏，重要）：

- 上游 `resetStaticRoutes` 只清 matcher，`generateAccessible` 会把动态路由 push 进 `Root` 记录的 `children` 数组；`removeRoute` 之后该数组仍保留，下一次登录会命中「按 name 更新」分支把上一账号的路由**复活**。
- 已封装 `resetAccessRoutes()`（`src/router/access.ts`）在静态清理后把 `Root` 替换为 `children: []` 的干净容器，并由 `src/router/index.ts` 的 `resetRoutes` 调用。store 侧登出只需继续调用现有 `resetRoutes()`，无需重复实现。
- 单测 `access-generation.test.ts` 覆盖「登出清理」「换账号不残留」。

### 2.3 「菜单隐藏只改善体验」的落地位置

- `src/constants/permissions.ts:13`（冻结文件原有条款）
- `src/router/access.ts:14-25` 注释
- `src/router/guard.ts:80-92` 注释
- 占位页底部提示 `ops-shell.placeholder.authorityNote`
- 本 journal §2.2

## 3. 菜单树（域 → 路由数）

一级入口 11 个 + 隐藏账号页 1 个；叶子页面 17 个。

| 域（文件） | 一级 path / 标题 | 一级数 | 子页面（动作码） |
| --- | --- | --- | --- |
| identity-audit | `/overview` 运营总览 | 1 | 运营总览（`overview.read`） |
| identity-audit | `/governance` 运营配置 | 1（2 子） | 账号与角色（`operator.read`）、系统设置（`settings.manage`） |
| identity-audit | `/audit` 审计与集成 | 1（2 子） | 审计日志（`audit.read`）、导出任务（`export.read`） |
| customer | `/customers` 客户管理 | 1 | 软件客户与联系人（`customer.read`） |
| catalog | `/catalog` 产品与套餐 | 1（2 子） | 产品目录、套餐与价格（均 `catalog.read`） |
| contract | `/contracts` 合同与订单 | 1 | 合同列表（`contract.read`） |
| billing | `/billing` 账款管理 | 1（2 子） | 应收计划、收款与核销（均 `receivable.read`） |
| entitlement | `/entitlements` 订阅与授权 | 1（2 子） | SaaS 订阅、授权与权益（均 `entitlement.read`） |
| tenant-integration | `/tenants` 租户交付 | 1 | 租户映射与开通（`tenant.read`） |
| deployment | `/deployments` 私有化部署 | 1 | 部署实例（`deployment.read`） |
| support | `/support` 售后工单 | 1 | 工单列表（`ticket.read`） |
| account | `/profile` 个人中心 | 0（隐藏） | 个人中心（无动作码，任何登录账号） |

菜单顺序：`overview(1) → customer(2) → catalog(3) → contract(4) → billing(5) → entitlement(6) → tenant(7) → deployment(8) → support(9) → governance(10) → audit(11)`。默认首页：`preferences.app.defaultHomePath = '/overview'`。

## 4. 验收结果（真实输出）

环境：`export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"`，`corepack pnpm`（Node 24.20.0 / pnpm 10.33.4）

| 命令 | 结果 | 摘要 |
| --- | --- | --- | --- | --- |
| `pnpm --filter @vben/web-antd typecheck` | **失败（非本任务文件）** | 6 条错误，全部在 `src/api/__tests__/request.test.ts`（并行专家新建的用例文件）。`src/router/**`、`src/views/**`、`src/layouts/**`、`src/preferences.ts` 0 错误 |
| `pnpm --filter @vben/web-antd test:unit` | **失败（非本任务用例）** | `Test Files 1 failed | 6 passed (7)`/`Tests 10 failed | 40 passed (50)`；失败全部来自 `src/api/**tests**/request.test.ts`。本任务套件单独运行 `vitest run --dom src/router/**tests**`→`Test Files 5 passed (5)`/`Tests 22 passed (22)`，exit 0 |
| `pnpm run lint:check` | **失败（非本任务文件）** | oxlint 段 3 errors，全部在 `src/api/__tests__/request.test.ts`（`no-non-null-assertion`）；eslint / stylelint 未被执行。本任务涉及目录单独 `eslint` exit 0，`stylelint` exit 0 |

> 三条命令失败的命中位置在本次并行开发中持续变化（另一位专家正在同一分支改造 `src/api/**`、`src/store/auth.ts` 并新增用例）。以上为本次最后一次执行的快照；未修改任何对方文件。另注：`src/constants/permissions.ts`（冻结）存在 5 条 `perfectionist/sort-sets` 违规，需 leader 决策。

## 5. 单测矩阵（`src/router/__tests__/`）

| 文件 | 覆盖 |
| --- | --- |
| `route-authority.test.ts` | 每个叶子声明动作码且属于冻结目录、无角色名；有权限可见/无权限整棵子树不可见；单码不串域；全量码 11 个一级模块 |
| `menu-from-access-codes.test.ts` | 菜单由 `accessCodes` 派生；`['admin','finance']` 等角色名产生 0 菜单；按 `order` 排序；`hideInMenu` 不入菜单 |
| `unauthorized-404.test.ts` | 无权限 URL 命中 `FallbackNotFound` 且路由未注册；有权限正常解析；无任何权限时全落 404；`/error/403` 可直达 |
| `access-generation.test.ts` | 登录后按码生成路由；登出清理后动态路由移除、core 保留；换账号只保留新账号路由 |
| `guard-access-codes.test.ts` | 守卫取码优先级：store > `userInfo.accessCodes`；只有 `roles` 时视为无权限；过滤非法值 |

## 6. 未完成 / 待跟进

1. **403 页默认不可达**：口径为「菜单不可见 + 直达 404」，403 仅在声明 `meta.menuVisibleWithForbidden` 时生效（本阶段未启用）。若产品要求某模块明示「可申请权限」，在对应路由加该标记即可。
2. **登录后无权限分支未在本层实现**：`accessCodes` 为空时守卫会放行到 `homePath` 并落 404，页面呈现为「不存在或无权访问」。账号停用/非运营成员的专门提示依赖 store 侧登录流程（另一位专家）与 `/auth/no-access`、`/auth/disabled` 页面（设计文档 §2.2，未在本任务范围）。
3. **登录页错误文案依赖后端错误码**：`login-error.ts` 已按 `AUTH_REQUIRED / FORBIDDEN / RATE_LIMITED / *disabled*` 等关键字与 HTTP 状态归类，后端最终码表确认后需回归一次（尤其是「停用」与「无运营成员」的区分，契约 §6.1 仍未定稿）。
4. **`enableRefreshToken` / `loginExpiredMode` 未改动**：属认证生命周期（API/续期）范围，避免与并行改造冲突；UI 已保留 `AuthenticationLoginExpiredModal`。
5. **`useOpsPermission` 位置**：因写权限边界不含 `src/composables/`，暂放 `src/views/ops/_shared/use-ops-permission.ts`；若后续允许新增 `src/composables/`，可平移并保持 re-export。
6. **演示视图目录**：`views/dashboard/**`、`views/demos/**`、`views/_core/about/**` 未删除（超出可写范围），仅无路由引用。
7. **`src/constants/permissions.ts` 存在 lint 违规**（`perfectionist/sort-sets` 5 条），该文件已冻结，需 leader 决定是调整规则还是由权限目录负责人一次性重排后重新冻结。
