# 运营后台前端骨架与权限接入设计（web-antd）

- 日期：2026-10-29
- 范围：`D:/MYC/Coding/ERP-ops/admin/apps/web-antd/`（上游 Vben v5.7.0 纯净模板）
- 关联任务：运营后台实施计划 Task 3「运营身份、应用壳与 API 契约接入」
- 需求真源：[PRD §4/§5](../../../Docs/PRD.md)、[FRONTEND.md](../../FRONTEND.md)、[PROJECT_STRUCTURE.md](../../PROJECT_STRUCTURE.md)、[DESIGN.md](../../../DESIGN.md)
- 后端真源：`../udone/apps/api/`（只读核对；运营 `ops` API 尚未实现）

本文只回答「怎样把 demo 模板改造成真实运营后台骨架」，不含业务实现代码。

---

## 1. 现状判定

### 1.1 认证链路（逐环节）

| 环节 | 现状 | 源码依据 | 判定 |
| --- | --- | --- | --- |
| 登录表单 | 自带 `vben/admin/jack` 三个演示账号下拉，选中即回填密码 `123456`；表单含滑块验证码组件 | `src/views/_core/authentication/login.vue:16-29`（`MOCK_USER_OPTIONS`）、`:52-67`（依赖回填 `password: '123456'`）、`:82-87`（`SliderCaptcha`） | **必须替换**：删除演示账号与滑块，改为邮箱+密码（或后端指定的 Supabase Auth 方式），并补内联错误呈现 |
| 登录接口 | `POST /auth/login`，返回 `{ accessToken }` | `src/api/core/auth.ts:24-26` | **必须替换**为运营登录端点 |
| 登录成功编排 | 先 `setAccessToken`，再并发拉 `user/info` + `auth/codes`，写入 `userStore` / `accessStore`，最后 `router.push(homePath)` | `src/store/auth.ts:36`、`:40`、`:43-51`、`:56-61` | **保留结构、替换数据源**：并发拉取的编排可复用，但需加「无权限/停用」分支与失败态 |
| 用户信息 | `GET /user/info` → `UserInfo{ userId, username, realName, avatar, roles, homePath, token }` | `src/api/core/user.ts:8-10`；类型 `packages/types/src/user.ts:4-18` | **必须替换**为 `GET /ops/me`，且 `token` 字段不使用（令牌不进入用户对象） |
| 权限码 | `GET /auth/codes` → `string[]` 写入 `accessStore.accessCodes` | `src/api/core/auth.ts:49-51`；`src/store/auth.ts:45,51` | **保留形状、替换来源**：运营权限动作目录 |
| 令牌注入 | 请求拦截器统一写 `Authorization: Bearer ${accessToken}`，同时写 `Accept-Language` | `src/api/request.ts:59-72` | **保留**，补 `X-Request-Id` |
| 令牌刷新 | `POST /auth/refresh`，**带 `withCredentials: true`**；成功回填 `accessStore` | `src/api/core/auth.ts:31-35`；`src/api/request.ts:51-57` | **保留机制**（模板已按 HttpOnly cookie 刷新设计），**当前被 `enableRefreshToken: false` 关闭**（`packages/@core/preferences/src/config.ts:25`） |
| 401 处理 | `enableRefreshToken` 为假 → 直接 `doReAuthenticate`；`loginExpiredMode` 默认 `'page'` → 直接 `logout()` 跳登录页 | `packages/effects/request/src/request-client/preset-interceptors.ts:64-72`；`src/api/request.ts:33-46`；`packages/@core/preferences/src/config.ts:30` | **必须替换策略**：打开 refresh、改 `'modal'` 以保留现场 |
| 登出 | `POST /auth/logout`（`withCredentials`）→ `resetAllStores()` → 跳登录页带 `redirect` | `src/store/auth.ts:80-98` | **必须补漏**：未调用 `resetRoutes()`，见 §1.4 |
| 会话过期弹窗 | 布局内 `AuthenticationLoginExpiredModal` 绑定 `accessStore.loginExpired` | `src/layouts/basic.vue:245-250` | **保留**，`loginExpiredMode` 改 `'modal'` 后即生效 |
| 无运营权限 / 账号停用 | **完全缺失**：`authLogin` 内无 `permissions` 为空或 `403` 分支 | `src/store/auth.ts:28-78`（`try/finally` 无 `catch`） | **必须新增**：独立拒绝页与状态机 |
| 网络失败 | 仅靠统一 `message.error` 提示，无页面级兜底 | `src/api/request.ts:95-104`；`packages/effects/request/src/request-client/preset-interceptors.ts:121-131` | **必须新增**：登录页可重试错误态 + 全局离线页 |

### 1.2 令牌存储位置（合规关键）

模板的令牌**持久化到浏览器存储**，且与规范冲突：

| 事实 | 源码依据 |
| --- | --- |
| `accessStore` 的持久化白名单包含 `accessToken`、`refreshToken`、`accessCodes` | `packages/stores/src/modules/access.ts:102-111` |
| 开发环境直接用**明文** `localStorage` | `packages/stores/src/setup.ts:56-57` |
| 生产环境用 SecureLS（`aes` + `VITE_APP_STORE_SECURE_KEY`）写入 `localStorage` | `packages/stores/src/setup.ts:46-51`、`:58-65` |
| 加密密钥随构建产物下发，`.env` 中仍是占位值 | `apps/web-antd/.env`（`VITE_APP_STORE_SECURE_KEY=please-replace-me-with-your-own-key`） |
| `initStores` 对所有 store 统一安装持久化插件 | `packages/stores/src/setup.ts:42-70` |

结论：**当前实现 = 可被同源 XSS 读取的 bearer token 持久化**，直接违反 `FRONTEND.md:21`「不得在本地持久化运营 bearer token 到非安全存储」。SecureLS 只是混淆，密钥同包下发，不构成安全存储。

### 1.3 菜单与路由来源

| 事实 | 源码依据 |
| --- | --- |
| 路由模块通过 `import.meta.glob('./modules/**/*.ts', { eager: true })` 汇总 | `src/router/routes/index.ts:7-16` |
| `accessRoutes = [...dynamicRoutes, ...staticRoutes]`，core 路由不走拦截 | `src/router/routes/index.ts:24-36` |
| `preferences.app.accessMode` 默认 `'frontend'`（本地路由表 + 前端过滤） | `packages/@core/preferences/src/config.ts:5` |
| `'backend'` 模式下菜单来自 `fetchMenuListAsync`，本应用把它接到了 `GET /menu/all` | `packages/utils/src/helpers/generate-routes-backend.ts:30-36`；`src/router/access.ts:27-33` |
| **`'frontend'` 模式不会调用 `fetchMenuListAsync`**（`generateAccess` 里仍传了该回调，属于死代码） | `packages/effects/access/src/accessible.ts:87-111`；`src/router/access.ts:17-40` |
| 前端模式按 `route.meta.authority` 与 **传入的 `roles` 数组**求交集过滤 | `packages/utils/src/helpers/generate-routes-frontend.ts:14-16`、`:36-44` |
| 守卫把 **`userInfo.roles`** 当作上述 `roles` 传入 | `src/router/guard.ts:95-96`、`:99-104` |
| 菜单由路由树生成，`show: !meta.hideInMenu`，再过滤隐藏项 | `packages/utils/src/helpers/generate-menus.ts:26-83`、`:89` |
| 无权限且未声明 `menuVisibleWithForbidden` 的路由被整棵剔除 → 直接访问落到 404 兜底路由 | `generate-routes-frontend.ts:23-29`；`src/router/routes/core.ts:11-21` |
| 声明 `menuVisibleWithForbidden` 的路由保留在路由表，但组件被替换为 403 页 | `generate-routes-frontend.ts:23-28`、`:50-55`；`src/router/access.ts:15,35` |
| 未登录访问非 core 路由 → 重定向 `/auth/login?redirect=` | `src/router/guard.ts:66-86` |
| 已登录访问 `/auth/login` → 跳 `redirect` 或 `homePath` | `src/router/guard.ts:54-63` |
| `isAccessChecked` 为真后守卫直接放行（不再重建路由） | `src/router/guard.ts:89-91` |
| 动态路由被塞进 `Root` 的 children 并整体重注册 | `packages/effects/access/src/accessible.ts:32-67` |

**关键结论**：现有机制的 `meta.authority` 语义是「角色」，而 PRD §4.2 要求「按动作授权」。若直接把 `receipt.approve` 写进 `authority`，在默认 `'frontend'` 模式下会拿它和 `roles` 比较而永不命中。

### 1.4 路由重置缺陷（跨账号泄漏）

- `resetAllStores()` 只重置 store（`packages/stores/src/setup.ts:72-81`），**不清理已注册到 router 的动态路由**。
- 登出流程（`src/store/auth.ts:80-98`）没有调用 `src/router/index.ts:32` 导出的 `resetRoutes`。
- 后果：同一标签页内切换账号后，前一个用户独有的路由仍留在路由表里，可被直接 URL 命中（数据仍由后端拒绝，但页面与菜单结构泄漏）。
- `resetRoutes` 只保留初始 `routes` 白名单中的 name 对应路由（`packages/utils/src/helpers/reset-routes.ts:8-28`）。

### 1.5 Mock 接入点

| 事实 | 源码依据 |
| --- | --- |
| `.env.development` 开启 `VITE_NITRO_MOCK=true` | `apps/web-antd/.env.development` |
| Nitro mock 插件默认在非构建期开启，随后被 env 覆盖 | `internal/vite-config/src/config/application.ts:43`；`internal/vite-config/src/utils/env.ts:103`；`internal/vite-config/src/plugins/index.ts:154-157` |
| dev 代理把 `/api` 前缀**剥掉**后转发到 `http://localhost:5320/api` | `apps/web-antd/vite.config.ts:8-16` |
| 生产 `VITE_GLOB_API_URL=/api`（同源） | `apps/web-antd/.env.production` |
| 生产配置从 `window._VBEN_ADMIN_PRO_APP_CONF_` 读取，dev 从 `import.meta.env` 读取 | `packages/effects/hooks/src/use-app-config.ts:13-27` |

### 1.6 演示内容与响应信封

| 事实 | 源码依据 | 判定 |
| --- | --- | --- |
| 演示路由：`/dashboard`、`/demos/ant-design`、`/vben-admin/*`、`/profile` | `src/router/routes/modules/{dashboard,demos,vben}.ts` | **删除**（`/profile` 可保留并改造） |
| 登录页含注册/验证码/二维码/忘记密码入口，默认全部显示 | `packages/effects/common-ui/src/ui/authentication/login.vue:33-40`、`:147-184` | **删除**：PRD §4.1 明确不提供公开注册 |
| 注册/验证码/二维码/忘记密码四个 core 路由 | `src/router/routes/core.ts:59-93` | **删除** |
| 顶栏假通知数据（6 条硬编码）与 Vben 文档/GitHub 外链菜单 | `src/layouts/basic.vue:25-76`、`:88-123` | **删除** |
| 统一响应拦截器要求 `{ code: 0, data: ... }` 信封，否则抛错 | `src/api/request.ts:75-81`；`preset-interceptors.ts:29-43` | **必须替换**：后端无此信封（见 §1.7） |
| 400/404 等条目中文案来自 `@vben/locales` 内置 fallback | `preset-interceptors.ts:133-160` | **保留**（作为无 code 命中的兜底） |
| `request` 最终抛出的是**响应体**而非 Error | `packages/effects/request/src/request-client/request-client.ts:158-160` | **必须替换**为结构化错误类型 |
| 默认超时 10s | `request-client.ts:66` | **保留基线**，长命令按域覆盖 |
| `refreshTokenApi` 走 `baseRequestClient`（无任何响应拦截器），因此 `resp.data` 是**整个 axios 响应体**，模板假定该 body 是裸 token 字符串 | `src/api/request.ts:113`；`src/api/core/auth.ts:31-35`；`src/api/request.ts:53-55` | **必须替换**：改为读取 `accessToken` 字段 |

### 1.7 后端现有契约事实（只读核对，非猜测）

| 事实 | 源码依据 |
| --- | --- |
| 鉴权方式为 `Authorization: Bearer <jwt>`，缺失即 401 `AUTH_REQUIRED` | `udone/apps/api/src/middleware/auth.ts:52-70` |
| 组织域路由需额外 `X-Organization-ID` | `udone/apps/api/src/middleware/auth.ts:62-68` |
| 错误体统一 `{ code, message, requestId, details? }`，并回写 `X-Request-Id` | `udone/apps/api/src/middleware/error-handler.ts:19-31` |
| 请求 ID 可**由客户端提供**（`X-Request-Id`，≤128 字符），否则服务端生成 | `udone/apps/api/src/middleware/request-id.ts:5-11` |
| 错误码目录：`AUTH_REQUIRED / FORBIDDEN / TENANT_SCOPE_DENIED / ORG_CONTEXT_REQUIRED / VALIDATION_ERROR / NOT_FOUND / CONFLICT / OBJECT_REFERENCED / ORDER_STATE_CONFLICT / RATE_LIMITED / INTERNAL_ERROR` | `udone/packages/contracts/src/errors.ts:6-18` |
| 成功响应**无 `{code,data}` 信封**，直接返回业务 JSON | `udone/apps/api/src/modules/customers/routes.ts`（`context.json(...)` 直出）；`udone/packages/contracts/src/routes.ts:76-100` |
| 端点路径形如 `/api/health`、`/api/me`，与前端 `baseURL='/api'` 拼接逻辑一致 | `udone/packages/contracts/src/routes.ts:76-86` |
| CORS `credentials: false`，且注释明确「API 以 bearer 调用，不允许通配来源」 | `udone/apps/api/src/middleware/cors.ts:37-45`、`:9-11` |
| CORS 允许头含 `Authorization / X-Organization-ID / Idempotency-Key / X-Request-ID` | `udone/apps/api/src/middleware/cors.ts:37-43` |
| 错误码风格为 `resource.action`（`organization.read`、`member.manage`） | `udone/packages/contracts/src/index.test.ts:15-19` |
| 后端目前**没有任何 `ops` 路由/模块** | `udone/apps/api/src/app.ts:1-33` 仅挂载 health/organizations/members/customers/orders/suppliers/finance |

---

## 2. 目标骨架设计

### 2.1 API adapter 层

#### 2.1.1 分层与职责

```text
src/api/adapter/          # 只此一层知道环境、头、错误码、重试
  env.ts                  # 环境变量校验 + baseURL 解析
  request-id.ts           # requestId 生成/透传/回写
  error.ts                # 后端错误码 → i18n key + 用户文案 + 可恢复性判定
  auth-events.ts          # 401/403/停用 的单一出口（避免各域自行跳转）
src/api/request.ts        # RequestClient 组装（保留文件，重写拦截器）
src/api/core/*.ts         # 会话端点（login/refresh/logout/me/codes）
src/api/ops/<domain>.ts   # 业务端点，只做 URL/参数/类型，不做错误处理
```

业务模块**只能** `import { requestClient } from '#/api/request'` 或自己的 `#/api/ops/<domain>`；禁止在页面内 `axios`/`fetch`、禁止拼接 baseURL、禁止自行捕获 401。

#### 2.1.2 环境变量校验

| 变量 | 校验规则 | 失败行为 |
| --- | --- | --- |
| `VITE_GLOB_API_URL` | 必填；必须为 `/` 开头的同源相对路径，或 `https://` 绝对地址；禁止 `http://`（除 `localhost` 开发） | 启动即 `throw`，渲染致命错误页（不静默回退到 mock） |
| `VITE_NITRO_MOCK` | 生产构建必须为 `false` | 构建期断言失败（见 §2.1.7） |
| `VITE_APP_NAMESPACE` | 必填，且不得为 `vben-web-antd` | 启动 `throw`（避免与模板缓存键混用） |
| `VITE_APP_STORE_SECURE_KEY` | 若仍保留持久化 store 则必填且非占位值 | 启动 `throw` |

依据：`src/api/request.ts:22` 现在直接取 `apiURL` 且无任何校验；`use-app-config.ts:13-27` 在 dev/prod 走两条不同来源，必须在一处归一化。

#### 2.1.3 baseURL 解析

- 统一为「源 + 前缀」：`VITE_GLOB_API_URL=/api` → `baseURL='/api'`，端点写 `/ops/customers`，最终 `/api/ops/customers`。
- 这与后端既有 `/api/...` 路径风格一致（`udone/packages/contracts/src/routes.ts:79`），也与 dev 代理的「剥 `/api` 再补 `/api`」行为一致（`apps/web-antd/vite.config.ts:10-12`）。
- 运营命名空间（`/api/ops` 还是 `/api/v1/ops`）**待契约确认**，adapter 只暴露一个常量 `OPS_API_PREFIX`，全部端点基于它拼接，改名只改一行。

#### 2.1.4 请求头与 requestId

| 头 | 规则 |
| --- | --- |
| `Authorization` | `Bearer <内存 accessToken>`，无 token 时**不写该头**（现在会写 `Bearer null`，见 `request.ts:59-61,68`） |
| `Accept-Language` | 保留（`request.ts:69`） |
| `X-Request-Id` | 每次请求生成 UUID v4；若调用方显式传入（如重试需保持同一 ID）则复用 |
| `Idempotency-Key` | 仅跨系统命令类写操作携带，由调用方在 `config.headers` 显式给出，adapter 不自动生成 |
| `X-Organization-ID` | 运营端**不发送**（不属组织域），由后端 ops 中间件按运营成员关系判定 |

响应侧从 `X-Request-Id` 响应头与错误体 `requestId` 双通道取值，写入结构化错误对象，供提示文案与问题反馈。

#### 2.1.5 统一错误映射

后端错误体是 `{ code, message, requestId, details? }`（`error-handler.ts:19-31`），前端必须：

1. 用 `code` 查本地映射表得到**用户可读中文**；
2. 不直接展示后端 `message`（英文内部文案，且可能含内部细节）；
3. `requestId` 附在提示的次级文案里，供运营反馈；
4. 未识别的 `code` 归入通用错误，保留 `requestId`。

| 后端 code | 前端语义 | 提示文案（zh-CN） | 可恢复 |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 未登录/会话失效 | 登录状态已失效，请重新登录 | 走 §2.2 刷新/重登 |
| `FORBIDDEN` | 无该动作权限 | 你没有执行此操作的权限 | 不可重试 |
| `TENANT_SCOPE_DENIED` | 跨租户越权 | 无权访问该对象 | 不可重试 |
| `ORG_CONTEXT_REQUIRED` | 缺少上下文（运营端不应出现） | 请求缺少必要的组织上下文 | 记录为缺陷 |
| `VALIDATION_ERROR` | 字段校验失败 | 提交内容有误，请检查标记字段 | 可修正后重试 |
| `NOT_FOUND` | 对象不存在或不可见 | 记录不存在或已被移除 | 不可重试 |
| `CONFLICT` | 并发/状态冲突 | 数据已变更，请刷新后重试 | 需刷新 |
| `OBJECT_REFERENCED` | 被引用不可删 | 该记录仍有关联数据，无法执行 | 不可重试 |
| `ORDER_STATE_CONFLICT` | 状态机非法迁移 | 当前状态不允许此操作 | 不可重试 |
| `RATE_LIMITED` | 触发限流 | 操作过于频繁，请稍后再试 | 可退避重试 |
| `INTERNAL_ERROR` | 服务端异常 | 服务暂时不可用，请稍后重试 | 可重试 |
| 无响应体（网络/超时） | 连接失败 | 网络连接失败，请检查网络后重试 | 可重试 |

`VALIDATION_ERROR` 的 `details.issues[].path`（`udone/apps/api/src/lib/contract.ts:6-14`）可用于表单字段级定位，映射到 `useVbenForm` 的字段错误；`details` 类型为 `unknown`，消费前必须运行时校验。

#### 2.1.6 401 刷新 / 重登策略

| 场景 | 行为 |
| --- | --- |
| 请求 401 且 `enableRefreshToken=true`、非重试请求 | 单飞刷新（`client.isRefreshing` + `refreshTokenQueue` 已有实现，`preset-interceptors.ts:74-96`） |
| 刷新成功 | 队列请求以新 token 重放；同时更新内存 token |
| 刷新返回 401/403 | 判定会话彻底失效 → 清 token → `loginExpired=true` → 弹重登框（保留当前路由与表单现场） |
| 刷新失败但为网络错误 | **不得登出**：提示网络异常并原样抛出，让页面进入可重试错误态 |
| `403 FORBIDDEN` | 不刷新、不登出；由页面呈现无权限态 |
| `403` + 停用类 code（待契约确认） | 清会话并跳「账号停用」页 |

改造点（相对模板）：

- `preferences.ts` 覆盖 `enableRefreshToken: true`、`loginExpiredMode: 'modal'`（模板默认 `false`/`'page'`，见 `packages/@core/preferences/src/config.ts:25,30`）。
- `doRefreshToken` 读取 `resp.data.accessToken`（现在假定 body 是裸字符串，`request.ts:53-55`）。
- 刷新失败分支需区分「网络错误」与「凭据失效」（现在一律 `await doReAuthenticate()`，`preset-interceptors.ts:97-104`）。
- `doReAuthenticate` 必须清理路由（§1.4）。

#### 2.1.7 响应解包：去掉 `{code:0,data}` 信封假设

模板的 `defaultResponseInterceptor({ codeField:'code', dataField:'data', successCode:0 })`（`request.ts:75-81`）会对任何不含 `code===0` 的响应抛错，而后端成功响应是业务 JSON 直出（§1.7）。两选一：

- **方案 A（推荐）**：`requestClient` 用 `responseReturn: 'body'`，删除 `defaultResponseInterceptor`，由各 `api/ops/*.ts` 的泛型声明返回类型。
- 方案 B：要求后端为所有 ops 响应加 `{code,data}` 信封 —— 与 `udone` 现有全部端点风格冲突，且与 `API_STANDARDS.md:8`「错误遵循后端现有稳定契约」相悖。

方案 A 的改造示意（≤15 行）：

```ts
export const requestClient = createRequestClient(apiURL, {
  responseReturn: 'body',
});
// createRequestClient 内：
client.addResponseInterceptor({ fulfilled: (r) => r.data }); // 成功直出 body
client.addResponseInterceptor(errorResponseInterceptor()); // 统一映射为 OpsApiError
```

同时 `request-client.ts:158-160` 把所有失败都压成 `error.response.data`，无法区分网络错误与业务错误；adapter 必须在 `errorResponseInterceptor` 内先构造 `OpsApiError { kind: 'network'|'http'|'auth', code?, status?, requestId?, messageKey }` 再抛出。

#### 2.1.8 token 存放方案（决策）

**结论：access token 只驻内存 + 刷新令牌放 HttpOnly Cookie，全部持久化白名单移除令牌。**

| 项 | 设计 |
| --- | --- |
| access token | 仅存 `accessStore.accessToken`（Pinia 内存），**从 `persist.pick` 移除** |
| refresh token | `Set-Cookie: __Host-ops_rt=<opaque>; HttpOnly; Secure; SameSite=Lax; Path=/`，JS 不可读 |
| 页面刷新 | 启动阶段静默调用 `POST /ops/auth/refresh`（`withCredentials`）换新 access token；失败则停留在登录页，不报「异常」 |
| 登出 | `POST /ops/auth/logout` 由服务端清 cookie + 本地清 store + `resetRoutes()` |
| 轮换 | 每次 refresh 轮换 refresh token（后端保证重放检测） |
| 兼容性 | 若后续要求跨站部署，cookie 需 `SameSite=None; Secure`，且后端 CORS 必须 `credentials: true` + 精确来源（当前 `credentials:false`，`udone/apps/api/src/middleware/cors.ts:45`） |

改造点清单：

1. `packages/stores/src/modules/access.ts:102-111`：`persist.pick` 删除 `accessToken`、`refreshToken`。这是**上游共享包补丁**，升级需重新应用（§5 风险 R4）。
2. `src/api/request.ts`：token 只从内存读取（该文件已如此，`request.ts:66-68`；仅需修 `Bearer null`）。
3. `src/main.ts` / `src/bootstrap.ts`：在 `initStores` 之后、`app.use(router)` 之前插入「静默续期」步骤（现在无此步骤，`bootstrap.ts:47-57`）。
4. `src/store/auth.ts`：`logout` 增加 `resetRoutes()`；`authLogin` 增加「无权限/停用」分支。
5. `.env`：`VITE_APP_STORE_SECURE_KEY` 不再是令牌保护手段，仅保护 preferences/tabbar 等非敏感 store；保留但不得写入真实密钥类值。

为什么不用「sessionStorage」：仍是 JS 可读，不满足 `FRONTEND.md:21` 的「非安全存储」约束；为什么不继续用 SecureLS：密钥随包下发（`.env` 中即为占位值），等同明文 + 混淆。

### 2.2 认证生命周期与 UI 落点

| 状态 | 触发条件 | UI 落点 | 关键实现点 |
| --- | --- | --- | --- |
| 启动中 | 应用挂载前 | 全局 loading（已有 `VITE_INJECT_APP_LOADING`，`vite-config/src/config/application.ts` 注入） | 静默续期期间不渲染登录页，避免闪烁 |
| 登录成功 | `POST /ops/auth/login` 200 且 `permissions.length > 0` | 跳 `redirect` → `me.homePath` → `preferences.app.defaultHomePath` | 复用 `store/auth.ts:56-61` 的优先级 |
| 登录成功但无任何权限动作 | 200 且 `permissions` 为空 | `/auth/no-access`（专用页，不自动重试） | 新增分支，模板无此逻辑 |
| 凭据错误 | 401 `AUTH_REQUIRED` | 登录表单**内联**错误（表单顶部 alert），不弹全局 toast | `AuthenticationLogin` 无错误插槽（`common-ui/.../login.vue:94-186`），需在应用层包一层 |
| 触发限流/MFA 待验证 | `RATE_LIMITED` / 待契约确认 | 登录表单内联提示 + 冷却倒计时 | 文案走 §2.1.5 |
| 无运营成员关系 | 200 但 `membership` 缺失，或 403 专属 code | `/auth/no-access`：说明「当前账号不是运营成员」+ 联系管理员 + 提供退出登录 | 该路由必须 `meta.ignoreAccess`（`guard.ts:68`） |
| 账号停用 | 403 专属 code 或 `me.membershipStatus='disabled'` | `/auth/disabled`：说明停用 + 退出登录，不提供重试 | 与「无权限」分离，避免误导 |
| 会话过期（页面内） | API 401 → 刷新失败 | 弹 `AuthenticationLoginExpiredModal`（保留现场） | `loginExpiredMode:'modal'`（`basic.vue:245-250`） |
| 主动登出 | 用户点击 | 清 store + `resetRoutes()` → `/auth/login?redirect=` | 补 `resetRoutes` |
| 被后端强制登出（角色撤销/停用） | 下一次请求 401/403 | 同「会话过期」，提示「权限已变更，请重新登录」 | 不区分来源页 |
| 网络失败（登录） | 无响应/超时 | 表单内联可重试错误 + 保留已填内容 | 区分 network vs auth（§2.1.6） |
| 网络失败（页面内） | 无响应/超时 | 页面级错误态 + 重试按钮；连续失败展示离线兜底 `Fallback status="offline"` | 已有组件 `views/_core/fallback/offline.vue`，当前无路由引用 |
| 后端 5xx / 部分依赖故障 | 5xx | 保留已加载数据 + 顶部告警条，不整页白屏 | 对应 PRD §6.1「部分服务不可用有明确状态」 |

补充约束：

- 全站**不提供注册入口**（PRD §4.1）：删除 `core.ts:59-93` 四条 auth 子路由，并在 `AuthenticationLogin` 上显式 `:show-register="false" :show-code-login="false" :show-qrcode-login="false" :show-forget-password="false"`（这些 prop 默认均为 `true`，`common-ui/.../login.vue:33-40`）。
- 登录页「记住我」只记用户名（`common-ui/.../login.vue:61-77` 已如此），不涉及令牌，可保留。

### 2.3 权限驱动呈现（三层）

#### 2.3.1 权限动作目录

单一真源：`src/constants/permissions.ts`（前端只读副本，与后端 `udone` 契约校验一致）。命名遵循 PRD §4.2 与后端既有 `resource.action` 风格（`udone/packages/contracts/src/index.test.ts:15`）。

| 模块 | 动作（PRD 已定义） | 待契约确认 |
| --- | --- | --- |
| 总览 | — | `overview.read` |
| 客户 | `customer.read`、`customer.write` | `customer.contact.manage` |
| 产品/套餐 | — | `catalog.read`、`catalog.write` |
| 合同 | `contract.read`、`contract.write`、`contract.approve` | `contract.terminate` |
| 账款 | `receivable.read`、`receivable.write`、`receipt.record`、`receipt.reconcile`、`receipt.refund` | `receipt.read`、`receipt.approve` |
| 订阅/授权 | `entitlement.read`、`entitlement.request`、`entitlement.approve`、`entitlement.execute` | — |
| 租户交付 | `tenant.provision`、`tenant.suspend`、`tenant.restore` | `tenant.read`、`tenant.command.retry` |
| 私有化部署 | `deployment.read`、`deployment.write` | `deployment.upgrade` |
| 售后工单 | `ticket.read`、`ticket.assign`、`ticket.update`、`ticket.close` | `ticket.reopen` |
| 运营配置 | `operator.manage` | `role.manage`、`dictionary.manage` |
| 审计与集成 | `audit.read` | `integration.read`、`export.create` |

> `receipt.approve` 已在计划 Task 5 负责人默认规则中出现（`exec-plans/active/2026-10-05-ops-console-implementation.md:164`），必须纳入目录。

#### 2.3.2 三层实现

| 层 | 载体 | 机制 | 源码依据 |
| --- | --- | --- | --- |
| 路由 | `meta.authority: string[]`（元素为**权限动作**） | 守卫把 `accessCodes` 传入 `generateAccess`，前端模式用 `filterTree` 求交集 | `generate-routes-frontend.ts:14-44`；`guard.ts:95-104` |
| 菜单 | 由路由树自动派生，无独立声明 | `show: !meta.hideInMenu` + 过滤 | `generate-menus.ts:26-89` |
| 按钮/区块 | `v-access:code="'receipt.approve'"` 或 `<AccessControl type="code" :codes="[...]">` | 指令 `mounted` 时无权限即 `el.remove()`；组件用 `hasAccessByCodes` | `directive.ts:20-29`；`access-control.vue:36-47`；`use-access.ts:29-34` |

**必须做的机制改造**：`guard.ts:95-104` 现在传的是 `userRoles`。改为传 `accessStore.accessCodes`（登录后由 `/ops/me` 或 `/ops/auth/codes` 写入），使 `meta.authority` 的语义从「角色」变为「权限动作」。同时约定：

- 禁止在 `meta.authority` 写角色名；角色只用于后台配置与审计展示。
- `meta.authority` 是 **OR** 语义（任一动作即可进路由）；需要 AND 的场景用组合动作或在页面内二次判定。
- `v-access:role` 在全项目禁用（`directive.ts:20-23` 仅在 `accessMode==='frontend' && arg==='role'` 时走角色判断，语义易混）；统一 `v-access:code`。
- `<AccessControl>` 的 `type` 默认 `'role'`（`access-control.vue:31-34`），必须显式传 `type="code"`。

#### 2.3.3 「菜单隐藏不是授权」

必须写进代码评审清单与页面模板注释：

1. 无权限路由在**前端不生成**，直接 URL 落到 404 兜底（`core.ts:11-21`）；这不是安全边界，只是一个更差的体验。
2. 真正边界在服务端：每个写操作由 `requireAuth` + 权限检查 + RLS 拒绝（`udone/apps/api/src/middleware/auth.ts:52-70`，`ARCHITECTURE.md:32`）。
3. 因此前端**不得**把「按钮已隐藏」当作写请求可以省略权限校验的理由；也不得因为「后端会拒」而不做前端态（PRD §4.3 要求两者都做）。
4. 403 的两种呈现：
   - 需要让用户知道功能存在并申请权限的模块：`meta.menuVisibleWithForbidden: true` → 菜单可见、点击进 403 页（`generate-routes-frontend.ts:23-28,50-55`）。
   - 其余模块：不生成路由；404 兜底页文案改为「页面不存在或你没有访问权限」，避免把越权探测结果暴露成「存在但禁止」。
5. 单页内的动作级拒绝不跳 403 页，而是就地禁用 + 悬浮说明（`receipt.approve` 等高风险按钮尤其如此）。

### 2.4 运营导航壳（PRD §5 → 路由文件）

一级导航与 PRD §5 十一条对齐；`path` 前缀统一 `/`（无 `/ops` 冗余段，靠域名区分系统），`order` 决定菜单顺序。

| # | 一级模块 | 路由文件 | 一级 path | 二级页面（path / name / 权限动作） |
| --- | --- | --- | --- | --- |
| 1 | 运营总览 | `modules/overview.ts` | `/overview` | `/overview` → `OverviewDashboard` / `overview.read`（待确认） |
| 2 | 客户管理 | `modules/customers.ts` | `/customers` | `/customers/list` → `CustomerList` / `customer.read`；`/customers/:id` → `CustomerDetail` / `customer.read`（`hideInMenu`） |
| 3 | 产品与套餐 | `modules/catalog.ts` | `/catalog` | `/catalog/products` → `ProductList` / `catalog.read`；`/catalog/plans` → `PlanList` / `catalog.read`（均待确认） |
| 4 | 合同与订单 | `modules/contracts.ts` | `/contracts` | `/contracts/list` → `ContractList` / `contract.read`；`/contracts/create` → `ContractCreate` / `contract.write`；`/contracts/:id` → `ContractDetail` / `contract.read`（`hideInMenu`） |
| 5 | 账款管理 | `modules/billing.ts` | `/billing` | `/billing/receivables` / `receivable.read`；`/billing/receipts` / `receipt.read`；`/billing/reconciliation` / `receipt.reconcile`；`/billing/refunds` / `receipt.refund` |
| 6 | 订阅与授权 | `modules/entitlements.ts` | `/entitlements` | `/entitlements/subscriptions` / `entitlement.read`；`/entitlements/licenses` / `entitlement.read`；`/entitlements/changes` / `entitlement.request` |
| 7 | 租户交付 | `modules/tenants.ts` | `/tenants` | `/tenants/mappings` / `tenant.read`；`/tenants/commands` / `tenant.read` |
| 8 | 私有化部署 | `modules/deployments.ts` | `/deployments` | `/deployments/instances` / `deployment.read`；`/deployments/upgrades` / `deployment.read` |
| 9 | 售后工单 | `modules/tickets.ts` | `/tickets` | `/tickets/list` / `ticket.read`；`/tickets/:id` / `ticket.read`（`hideInMenu`） |
| 10 | 运营配置 | `modules/settings.ts` | `/settings` | `/settings/operators` / `operator.manage`；`/settings/roles` / `role.manage`（待确认）；`/settings/dictionaries` / `dictionary.manage`（待确认） |
| 11 | 审计与集成 | `modules/audit.ts` | `/audit` | `/audit/events` / `audit.read`；`/audit/integrations` / `integration.read`（待确认） |

规则：

- 每个 `modules/<domain>.ts` 默认导出 `RouteRecordRaw[]`，由 `mergeRouteModules` 合并（`merge-route-modules.ts:13-24`），互不干扰。
- 父级不写 `component`（`accessible.ts:39-44` 会自动删除多层 `BasicLayout`），仅声明 `name/path/meta`。
- 每个**叶子**路由必须写 `name`（唯一）、`meta.title`（i18n key）、`meta.authority`、`meta.order`。
- `meta.title` 位于模块顶层 `$t(...)` 调用（现有写法 `modules/dashboard.ts:10`），因此语言键在模块加载时求值；切换语言**不会**热更新已生成的菜单标题 —— 这是上游行为，本项目接受（单语言 zh-CN 起步）。
- 默认首页：`preferences.ts` 覆盖 `app.defaultHomePath: '/overview'`（模板默认 `/analytics`，`config.ts:20`；`core.ts:38` 的 Root redirect 与 `guard.ts:111` 都读取该值，改一处生效）。
- `/profile` 从 `modules/vben.ts` 迁出，保留在 `modules/account.ts`（`hideInMenu`，改密码/安全设置），因为它是 topbar 用户下拉入口（`basic.vue:88-95` 依赖 `name: 'Profile'`）。

---

## 3. 实施文件清单

标记说明：**S** = 共享文件（全局只能由一人修改）；**O** = 独占（可按域并行认领）；**T** = 模板文件，删除或大幅重写。「验收方式」列给的是可执行断言或命令，默认前置 `pnpm run quality:check` 的子集。

### 3.1 外壳（Phase 0，串行，单人或同一分支顺序提交）

| 文件路径 | 类型 | 职责 | 依赖契约字段 | 验收方式 |
| --- | --- | --- | --- | --- |
| `apps/web-antd/src/api/adapter/env.ts` | 新增 S | 校验 `VITE_GLOB_API_URL / VITE_APP_NAMESPACE / VITE_NITRO_MOCK`，导出 `OPS_API_PREFIX`、`apiBaseURL` | — | 单测：缺变量/`http://` 生产地址/占位 namespace 均抛错 |
| `apps/web-antd/src/api/adapter/request-id.ts` | 新增 S | 生成/透传 `X-Request-Id`，读取响应头 | `X-Request-Id` | 单测：无传入时生成 UUIDv4；已传入时保持同一值 |
| `apps/web-antd/src/api/adapter/error.ts` | 新增 S | `ApiErrorBody` 运行时校验 + code→i18n key 映射 + `OpsApiError` 类型 | `{code,message,requestId,details?}` | 单测：11 个已知 code + 未知 code + 无响应体三类映射 |
| `apps/web-antd/src/api/adapter/auth-events.ts` | 新增 S | 401/403/停用 的集中处理入口，避免各域自跳 | — | 单测：401+网络错误不登出；401+凭据失效触发一次 `loginExpired` |
| `apps/web-antd/src/api/request.ts` | 修改 S T | 去 `{code,data}` 信封；注入头；错误映射；刷新单飞；`Bearer null` 修正 | — | 单测：拦截器返回 body；无 token 不带 `Authorization`；401 并发只刷新一次 |
| `apps/web-antd/src/api/core/auth.ts` | 修改 S T | 登录/刷新/登出/权限码 → 运营端点 | 登录响应 `{ accessToken, expiresAt?, user?, permissions? }`（待确认） | 单测：refresh 从 `data.accessToken` 取值；`withCredentials` 保持 |
| `apps/web-antd/src/api/core/user.ts` | 修改 S | `/user/info` → `GET /ops/me` | `{ userId, username, realName, avatar, roles[], permissions[], membershipStatus, homePath }`（待确认） | 单测：字段缺失走 `unknown` 校验失败而非静默成功 |
| `apps/web-antd/src/api/core/menu.ts` | 删除 S T | 前端模式不消费后端菜单（`accessible.ts:87-111`） | — | `grep -r getAllMenusApi src` 无结果 |
| `apps/web-antd/src/api/core/index.ts`、`src/api/index.ts` | 修改 S | 导出调整 | — | `pnpm --filter @vben/web-antd typecheck` |
| `apps/web-antd/src/constants/permissions.ts` | 新增 S | 权限动作常量 + `Permission` 字面量类型 + 运行时全量清单 | §2.3.1 目录 | 单测：与 `docs` 表格逐项一致；无重复字符串 |
| `apps/web-antd/src/store/auth.ts` | 修改 S T | 登录生命周期、静默续期、登出清理、`resetRoutes()`、无权限/停用分支 | 同上 | 单测：无权限不跳首页；登出后 router 无遗留动态路由 |
| `apps/web-antd/src/router/guard.ts` | 修改 S | `roles` → `accessCodes`；启动续期短路；无 membership 拦截 | — | 单测：mock codes 下 5 条路由的可见性矩阵 |
| `apps/web-antd/src/router/access.ts` | 修改 S | 移除 `fetchMenuListAsync` 死代码；保留 `forbiddenComponent` | — | typecheck + 单测 |
| `apps/web-antd/src/router/routes/index.ts` | 修改 S | 保持 glob；如启用 `external/` 再打开注释 | — | 单测：模块文件数 = 一级菜单数 |
| `apps/web-antd/src/router/routes/core.ts` | 修改 S T | 删 4 条 auth 子路由；新增 `/auth/no-access`、`/auth/disabled`、`/auth/forbidden`、`/error/500`、`/error/offline` | — | 单测：`/auth/register` 解析失败；新路由 `ignoreAccess` 生效 |
| `apps/web-antd/src/router/routes/modules/dashboard.ts`、`demos.ts`、`vben.ts` | 删除 S T | 演示路由 | — | 菜单只剩 §2.4 的 11 项 + 账户页 |
| `apps/web-antd/src/router/routes/modules/account.ts` | 新增 S | `/profile` 迁入，保留 `name: 'Profile'` | — | 顶栏下拉可打开 |
| `apps/web-antd/src/preferences.ts` | 修改 S | `enableRefreshToken`、`loginExpiredMode`、`defaultHomePath`、`app.name`、主题 token 映射 | — | 单测：默认值与设计一致 |
| `apps/web-antd/src/main.ts` | 修改 S | 启动静默续期（`initPreferences` 之后、`bootstrap` 之前） | refresh 端点 | 手测：硬刷新后不闪登录页 |
| `apps/web-antd/src/bootstrap.ts` | 修改 S | 保留指令注册；接入 auth-events 到 router 钩子 | — | 手测 + 单测 |
| `apps/web-antd/src/layouts/basic.vue` | 修改 S T | 删假通知与 Vben 外链；用户下拉接 `realName`/角色/登出；保留过期弹窗 | — | 手测：无 mock 文案残留 |
| `apps/web-antd/src/layouts/auth.vue` | 保留 S | 登录/拒绝页布局容器 | — | — |
| `apps/web-antd/src/views/_core/authentication/login.vue` | 修改 S T | 删演示账号/滑块；关闭注册等入口；内联错误态 | 登录入参：邮箱+密码（或后端指定） | 组件测试：错误/加载/成功三态 |
| `apps/web-antd/src/views/_core/authentication/{register,code-login,qrcode-login,forget-password}.vue` | 删除 S T | 无公开注册 | — | 文件不存在 |
| `apps/web-antd/src/views/_core/fallback/no-access.vue`、`disabled.vue`、`forbidden.vue`、`internal-error.vue`、`offline.vue` | 新增/修改 S | 五种拒绝/故障页，文案与行动点区分 | — | 组件测试：每页有唯一标题与主行动 |
| `apps/web-antd/src/locales/langs/{zh-CN,en-US}/page.json` | 修改 S | 删除 register/qrcode 等键；补拒绝页与壳文案 | — | `cspell` + 人工比对键集合 |
| `apps/web-antd/.env`、`.env.development`、`.env.production` | 修改 S | `VITE_NITRO_MOCK=false`；namespace 改 `ops-web-antd`；标题改运营后台；`VITE_GLOB_API_URL` 保持同源 `/api` | — | 构建产物中 `grep -r "5320\|mock"` 无命中 |
| `apps/web-antd/vite.config.ts` | 修改 S | dev 代理目标改为真实 API 主机（env 驱动），不再指向 `localhost:5320` | — | `pnpm dev:antd` 后 `/api/health` 返回后端真实响应 |
| `packages/stores/src/modules/access.ts` | 修改 S（上游补丁） | `persist.pick` 移除 `accessToken`/`refreshToken` | — | 单测：登录后 localStorage 键值中不含 token 明文；刷新页面需走 silent refresh |
| `apps/web-antd/playwright.config.ts` | 新增 S | E2E 基础配置（baseURL、reporter、`webServer`） | — | `pnpm --filter @vben/web-antd test:e2e` 可跑通 1 条冒烟 |
| `apps/web-antd/package.json` | 修改 S | 增加 `test:unit`、`test:e2e` 脚本与 `playwright` devDependency（根已有 `playwright` catalog 依赖） | — | `pnpm install --frozen-lockfile` 通过 |

### 3.2 业务域（Phase 1+，可并行）

以下每行是**一个域的完整文件集**，四个文件同属一个认领人，跨域零交集。

| 文件路径模板 | 类型 | 职责 | 依赖契约字段 | 验收方式 |
| --- | --- | --- | --- | --- |
| `src/api/ops/<domain>.ts` | 新增 O | 端点函数 + 请求/响应类型 + 查询参数编解码 | 该域 API schema（待契约确认） | 单测：参数序列化（分页/排序/筛选）与响应校验 |
| `src/router/routes/modules/<domain>.ts` | 新增 O | 该域路由树与 `meta.authority` | 权限动作名 | 单测：未授权时该域路由不在 `accessRoutes` 结果中 |
| `src/locales/langs/zh-CN/ops-<domain>.json`、`en-US/…` | 新增 O | 该域文案（文件名即命名空间，`locales/src/i18n.ts:55-89`） | — | `grep` 无硬编码中文；键完整 |
| `src/views/<domain>/index.vue`、`list.vue`、`detail.vue`、`components/*`、`__tests__/*.test.ts` | 新增 O | 页面与组件；loading/empty/error/permission-denied/conflict/destructive-confirm 六态 | 该域 DTO | 组件测试覆盖六态；E2E 覆盖主流程 |

域清单（与 §2.4 一一对应）：`overview`、`customers`、`catalog`、`contracts`、`billing`、`entitlements`、`tenants`、`deployments`、`tickets`、`settings`、`audit`。

### 3.3 测试基建（Phase 0 尾，与外壳同一责任人）

| 文件路径 | 类型 | 职责 | 验收方式 |
| --- | --- | --- | --- |
| `apps/web-antd/src/**/__tests__/*.test.ts` | 新增 O/S | 组件与 adapter 单测（Vitest 已在根 `vitest.config.ts` 生效，`test:unit` 为 `vitest run --dom`） | `pnpm run test:unit` 通过 |
| `apps/web-antd/e2e/auth.spec.ts` | 新增 S | 登录允许/拒绝、受保护路由重定向、无权限 URL、登出清理 | `test:e2e` 通过（后端未就绪时用契约 fixture） |
| `apps/web-antd/e2e/fixtures/*.ts` | 新增 S | 纯虚构运营身份与权限集 | secret scan 通过；无真实个人信息 |

> 现状核查：`apps/web-antd` 下 0 个 `*.test.ts`，全仓无 `playwright.config.*`；根 `package.json` 已装 `playwright` 且定义了 `test:e2e`（`turbo run test:e2e`），但没有任何应用定义该脚本 —— 因此 `test:e2e` 目前是空转。

---

## 4. 并行开发切分建议

### 4.1 目录所有权

| 所有权 | 目录/文件 | 说明 |
| --- | --- | --- |
| **Shell 负责人（1 人）** | `src/api/request.ts`、`src/api/adapter/**`、`src/api/core/**`、`src/api/index.ts`、`src/constants/**`、`src/store/**`、`src/router/{guard,access,index}.ts`、`src/router/routes/{index,core}.ts`、`src/router/routes/modules/account.ts`、`src/preferences.ts`、`src/main.ts`、`src/bootstrap.ts`、`src/layouts/**`、`src/views/_core/**`、`src/locales/langs/*/page.json`、`.env*`、`vite.config.ts`、`playwright.config.ts`、`packages/stores/src/modules/access.ts`、`apps/web-antd/package.json` | 全部 **S**。其他人只读 |
| 域负责人 A | `src/views/customers/**`、`src/api/ops/customers.ts`、`src/router/routes/modules/customers.ts`、`src/locales/langs/*/ops-customers.json` | 独占 |
| 域负责人 B | 同构：`catalog` | 独占 |
| 域负责人 C | 同构：`contracts` | 独占 |
| 域负责人 D | 同构：`billing` | 独占 |
| 域负责人 E | 同构：`entitlements` | 独占 |
| 域负责人 F | 同构：`tenants` + `deployments` | 独占（两域天然耦合） |
| 域负责人 G | 同构：`tickets` | 独占 |
| 域负责人 H | 同构：`settings` + `audit` | 独占（同属「配置/治理」） |

### 4.2 为什么这些能并行

- **路由零冲突**：`routes/index.ts:7-9` 用 glob 汇总 `modules/**/*.ts`，新增文件不需要改任何索引文件。
- **文案零冲突**：`locales/index.ts` 用 `import.meta.glob('./langs/**/*.json')`，每个 JSON 文件成为独立命名空间 `ops-<domain>`（`locales/src/i18n.ts:55-89`），不需要编辑共享 `page.json`。
- **API 零冲突**：每域一个 `api/ops/<domain>.ts`，只 import `#/api/request`（只读）与 `#/constants/permissions`（只读）。
- **权限码零冲突**：`constants/permissions.ts` 由 Shell 负责人一次性建立全量目录；域负责人**只能引用，不能新增**。缺码时走「变更申请」回到 Shell 负责人。

### 4.3 共享文件的最小改动点与集中修改顺序

严格按序，每步完成并通过 typecheck 后再进入下一步：

| 步 | 内容 | 涉及共享文件 | 最小改动 |
| --- | --- | --- | --- |
| 1 | 存储与安全基线 | `packages/stores/src/modules/access.ts` | 仅 `persist.pick` 数组删除两项（3 行） |
| 2 | 请求内核 | `src/api/adapter/*`（新增）、`src/api/request.ts` | 去信封、加 requestId、错误映射、修 `Bearer null` |
| 3 | 权限目录 | `src/constants/permissions.ts`（新增） | 一个常量对象 + 一个联合类型 |
| 4 | 会话端点与状态机 | `src/api/core/{auth,user,menu,index}.ts`、`src/store/auth.ts` | 端点替换 + `resetRoutes` + 无权限分支 |
| 5 | 路由与守卫 | `src/router/guard.ts`、`access.ts`、`routes/core.ts`、`routes/index.ts`、`preferences.ts` | `roles→accessCodes`；删 4 条 auth 路由；`defaultHomePath` |
| 6 | 壳视图与拒绝页 | `src/views/_core/**`、`src/layouts/basic.vue` | 登录页重写；5 个拒绝页 |
| 7 | 环境与构建 | `.env*`、`vite.config.ts`、`package.json`、`playwright.config.ts` | 关 mock；代理指真实 API |
| 8 | 各域并行 | 仅 **O** 文件 | — |

第 8 步开始的前提：第 1–7 步已合并且 `pnpm run quality:check` 绿（含 `check:type` 与 `test:unit`）。

### 4.4 域负责人开工前必须拿到的输入（缺一不可）

1. 权限动作名清单（来自 `src/constants/permissions.ts`，已合并）。
2. 该域 API 契约（endpoint、请求/响应 schema、错误码、分页/排序参数）。
3. 该域的菜单顺序号（`meta.order`）与图标名，避免多人抢同一序号。
4. 六态验收清单（loading/empty/error/permission-denied/conflict/destructive-confirm）。

---

## 5. 风险与卡点（按严重度排序）

| # | 风险 | 严重度 | 触发后果 | 缓解 |
| --- | --- | --- | --- | --- |
| R1 | **令牌持久化违规**：`accessStore` 把 `accessToken` 写入 localStorage（dev 明文、prod SecureLS 但密钥随包） | 高（安全/合规） | 违反 `FRONTEND.md:21`；XSS 可直接窃取长期会话 | §2.1.8：内存 token + HttpOnly refresh cookie + 移除 persist 白名单；补一条「localStorage 内不含 token」的自动化断言 |
| R2 | **运营 API 契约完全空白**（`udone/apps/api/src/app.ts:1-33` 无 ops 路由） | 高（阻塞） | 外壳可以写，业务域全部无法联调；易出现「按猜测字段写前端」 | 外壳先完成并冻结「会话契约 + 权限目录 + 错误映射」三件事；业务域在契约发布后才开工，期间只做静态骨架与 fixture |
| R3 | **Cookie 刷新与 CORS 冲突**：后端 `credentials: false` 且注释明确按 bearer 设计（`cors.ts:37-45`） | 高（架构） | 跨域部署时 refresh cookie 不会被浏览器发送，表现为「刷新页面必掉登录」 | 优先同源部署（`.env.production` 已是 `/api`）；若必须跨域，需 `udone` 改 `credentials: true` + 精确来源白名单 + `SameSite=None`。**需 leader 拍板** |
| R4 | **响应信封不匹配**：前端要求 `{code:0,data}`，后端直出业务 JSON | 高（阻塞） | 首个真实请求即抛错，且报错文案误导 | §2.1.7 方案 A（前端适配），不改后端风格 |
| R5 | **Vben 上游补丁耦合**：修改 `packages/stores/src/modules/access.ts` 持久化白名单 | 中（升级耦合） | 下次同步上游会丢失补丁，回退成明文持久化且难被测试发现 | 补丁点写进本文件与评审清单；增加断言测试；升级 checklist 固定检查该项 |
| R6 | **mock 残留**：`VITE_NITRO_MOCK=true`（`.env.development`）+ dev 代理指向 `localhost:5320` | 中 | 开发者以为在联调真实 API，实际走 mock；演示登录可用但生产不可用 | 统一置 `false`；代理指向真实 API；增加构建期断言与产物 `grep` |
| R7 | **`meta.authority` 语义改造**：从「角色」变为「权限动作」 | 中 | 若沿用模板语义，`authority: ['receipt.approve']` 永不命中，页面永远 403 | `guard.ts` 改传 `accessCodes`；评审规则禁止 `authority` 写角色名；禁用 `v-access:role` |
| R8 | **路由未重置**（§1.4） | 中（越权呈现） | 同标签页换账号后旧路由仍可达 | 登出与 `doReAuthenticate` 均调用 `resetRoutes()`；E2E 断言 |
| R9 | **测试基建缺失**：`apps/web-antd` 0 个 `*.test.ts`，无 `playwright.config.ts`，`test:e2e` 空转 | 中 | Task 3 要求的状态跳转与权限矩阵无法被自动化守住 | Phase 0 尾补 Vitest 组件测试 + Playwright 配置；把 `test:e2e` 纳入门禁前先让脚本真实存在 |
| R10 | **演示视图清退不彻底**：`views/dashboard/**`、`views/demos/**`、`views/_core/about/**` 仍被 glob 进 `pageMap`（`access.ts:18`） | 低 | 包体冗余、菜单泄漏演示入口 | 删除目录而非仅删路由 |
| R11 | **无运营成员关系的判定口径未定**：可能是 403、也可能是 200+空权限 | 中（阻塞 UI 分支） | 可能把「停用」误判成「无权限」，文案误导 | 契约必须区分 `no_membership` / `disabled` / `no_permission` 三种；前端按 code 分支 |
| R12 | **`VITE_ROUTER_HISTORY=hash`**（`.env.production`） | 低 | URL 带 `#`，影响客服排障与深链分享 | 若部署平台支持 SPA 回退，改 `history`；否则接受并写进运维说明 |

---

## 6. 不确定性清单（待契约确认）

> 后端 `ops` API 由另一路架构师并行设计。以下任一项未确认，对应实现必须停在「类型 + 空实现 + fixture」层面，不得臆造字段。

### 6.1 会话与身份

| 项 | 未知点 | 影响文件 |
| --- | --- | --- |
| 登录端点 | 路径（`/api/ops/auth/login`？）、入参（邮箱+密码 / 是否 MFA 二次步骤 / 是否走 Supabase OTP） | `api/core/auth.ts`、`views/_core/authentication/login.vue` |
| 登录响应 | 是否返回 `user` 与 `permissions`（省一次请求），还是仅 `accessToken` 再拉 `/me` 与 `/codes` | `store/auth.ts` |
| 权限来源 | `/me` 内嵌 `permissions`、独立 `/codes`、还是 JWT 声明 | `store/auth.ts`、`router/guard.ts` |
| 刷新端点 | 路径、cookie 名、`SameSite`/`Secure` 策略、轮换与重放检测 | `api/core/auth.ts`、`api/adapter/*`、部署配置 |
| 登出端点 | 是否仅清 cookie，是否需要 `POST` 语义 | `store/auth.ts` |
| 会话有效期 | access token TTL、refresh TTL、空闲超时 | `preferences.ts`、`api/adapter/auth-events.ts` |
| 拒绝语义 | `no_membership` / `disabled` / `no_permission` 分别用什么 HTTP 状态与 code | `views/_core/fallback/*`、`store/auth.ts` |
| 组织上下文 | 运营请求是否需要 `X-Organization-ID`（现有后端组织域强制，`auth.ts:62-68`） | `api/request.ts` |

### 6.2 权限目录

| 项 | 未知点 | 影响 |
| --- | --- | --- |
| 动作全集 | §2.3.1 中「待契约确认」的 13 项命名与是否存在 | `constants/permissions.ts`、全部 `modules/*.ts` |
| 角色映射 | 6 个预置角色（PRD §4.2）到动作集合的映射是否由后端下发 | `views/settings/**` |
| 权限变更生效 | 是否支持会话内热更新（否则必须重新登录） | `api/adapter/auth-events.ts` |
| 动作级 AND 需求 | 是否存在「必须同时具备两个动作」的页面 | `modules/*.ts` 的 `authority` 语义 |

### 6.3 API 通用约定

| 项 | 未知点 | 影响 |
| --- | --- | --- |
| 命名空间 | `/api/ops/...` 还是 `/api/v1/ops/...`；是否有版本协商头 | `api/adapter/env.ts` 的 `OPS_API_PREFIX` |
| 列表契约 | 分页参数名（`page/pageSize` vs `limit/offset`）、排序、筛选编码、总数返回位置 | 全部 `api/ops/*.ts`（`API_STANDARDS.md:9` 要求有界分页 + 确定性排序） |
| 错误码扩展 | 除 §1.7 的 11 个通用码外，ops 专属码有哪些（幂等冲突、命令待定、同步失败分类） | `api/adapter/error.ts` |
| 幂等 | `Idempotency-Key` 的适用范围与重复请求返回形态（首次结果 vs 409） | `api/ops/{tenants,entitlements,billing}.ts` |
| 导出 | 导出是同步流式下载还是异步任务 + 轮询；`receipt` 类附件下载鉴权方式 | 相关域 `api/ops/*.ts`、`requestClient.download` |
| 长任务超时 | 跨系统命令是否允许超过 10s 默认超时 | `api/ops/tenants.ts`（需按请求覆盖 `timeout`） |
| 时间与金额 | 时间格式（ISO8601 + 时区）、金额是字符串十进制还是数字、币种字段 | 全部列表/详情，`CODE_STANDARDS.md:18` 禁止静默转换 |

### 6.4 部署与运行

| 项 | 未知点 | 影响 |
| --- | --- | --- |
| 同源 or 跨域 | 前端与 `/api` 是否同域（决定 R3 是否成立） | cookie 策略、CORS |
| 路由模式 | `hash` 还是 `history`，静态托管是否支持 SPA 回退 | `.env.production`、部署配置 |
| 环境主机 | local/staging/production 的 API 主机与允许来源白名单 | `.env.*`、`vite.config.ts` |
| CSP | 是否允许 `unsafe-inline`（影响 antd 主题注入与 XSS 缓解强度） | 部署头配置 |

---

## 7. 结论摘要

1. 模板的认证链路**结构可复用**（登录 → token → me/codes → 动态路由），但**数据源、错误处理、权限语义、令牌存储四处必须重写**。
2. 令牌合规方案不是「换个存储」，而是**内存 access token + HttpOnly refresh cookie**；模板已埋好 `withCredentials` 刷新入口（`api/core/auth.ts:31-35`），只是被 `enableRefreshToken:false` 关掉，改造成本可控。
3. 权限驱动呈现的最小改造是**一处**：`guard.ts` 把 `roles` 换成 `accessCodes`；此后 `meta.authority` 才真正承载 `receipt.approve` 这类动作名。菜单自动派生，按钮用 `v-access:code`。
4. 并行的天然边界是**文件系统**：`modules/**` glob、`langs/*.json` glob、`api/ops/<domain>.ts` 三处让每个域零冲突；真正需要串行的只是 Phase 0 的近 30 个共享文件。
5. 当前最大阻塞不是前端，而是**后端 ops 契约空白**（R2）与**cookie/CORS 架构未定**（R3）。外壳可以先落地，业务域必须等契约。
