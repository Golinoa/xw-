# ops API 客户端

运营后台只消费 `Docs/ops-api-contract.md` 定义的 `/api/v1/ops/*`；**禁止**直连数据库、禁止在页面内自建 axios/fetch、禁止拼接 baseURL。所有请求经 `#/api/request` 的适配层（环境校验 / requestId / 错误映射 / 401 刷新 / 5xx 重试）。

## 目录

| 目录 | 契约 | 状态 |
| --- | --- | --- |
| `identity/` | §5.1 meta / session / permissions | ✅ 已实现（会话与权限目录） |
| `customer/` | §5.2 | ⬜ 待实现（见 README） |
| `catalog/` | §5.3 | ⬜ 待实现 |
| `contract/` | §5.4 | ⬜ 待实现 |
| `billing/` | §5.5 | ⬜ 待实现 |
| `entitlement/` | §5.6 | ⬜ 待实现 |
| `tenant/` | §5.7（tenant-integration） | ⬜ 待实现 |
| `deployment/` | §5.8 前半 | ⬜ 待实现 |
| `support/` | §5.8 后半 | ⬜ 待实现 |
| `__stub__/` | — | 开发态契约桩（仅 `VITE_OPS_MOCK=true`） |

每个域 `index.ts` 只导出「请求函数 + 类型」，错误处理、提示、跳转一律不在这里做。

## 开发态契约桩（`__stub__/`）

**作用**：后端 ops 模块当前**完全不存在**（由另一会话实现）。为了让前端能开发与联调前自测，桩在本地返回**虚构**的会话数据，让登录、权限码、会话状态机能跑通。

**它不是什么**：不是 mock 服务、不是假后端、不代表后端已集成。

- 桩数据全部虚构：邮箱为保留域名 `stub.operator@example.invalid`，名称带「（虚构）」后缀；
- 桩账号固定 `stub / stub`，其它口令返回 401，用来验证登录失败分支；
- 桩授予 `constants/permissions.ts` 的全部动作码，便于走通所有页面；
- 只要桩生效，页面顶部会出现黄色条幅「开发态契约桩 · 数据全部虚构 · 后端未接入」，由 `__stub__/banner.ts` 挂载（不依赖任何页面组件，因此不可能被漏掉）。

**如何关闭**：`apps/web-antd/.env.development` 里设 `VITE_OPS_MOCK=false`（默认值）。

**生产构建**：`resolveOpsEnv()` 在 `mode=production` 且 `VITE_OPS_MOCK=true` 时直接抛错；即便误配置，所有调用点都是 `import.meta.env.VITE_OPS_MOCK === 'true'` 的字面量比较，整个 `__stub__` 目录与动态 import 会被 tree-shake，不会进入产物。

**真实 API 就绪后如何切换**：把 `VITE_OPS_MOCK` 置为 `false`（或直接删除该变量）即可，调用点无需改动 —— 每个域函数都是「桩分支 + 真实 `requestClient` 分支」二选一。联调时建议先用 `VITE_OPS_MOCK=false` 跑一遍登录/会话，确认后端端点路径。

## 契约推导、待后端确认（不要擅自改）

| 项 | 现值 | 说明 |
| --- | --- | --- |
| 认证端点路径 | `/v1/ops/auth/login`、`/auth/refresh`、`/auth/logout` | 契约 §5.1 **未定义**认证端点，路径取自设计文档 §2.2；由后端会话负责人最终确认 |
| 登录响应体 | `{ accessToken }` | 契约未定；假定刷新令牌通过 `Set-Cookie`（HttpOnly）下发 |
| 刷新响应体 | `{ accessToken }` | 同上；轮换语义假定为「每次刷新轮换 refresh token」 |
| 登出语义 | `POST`，无请求体 | 假定服务端清 Cookie，事件幂等 |
| `operator.status` 枚举 | `active` / `invited` / `disabled` | 契约只出现 `status='invited'` 与 `OPS_MEMBER_INACTIVE`，其它取值由 §6.4 反推 |
| 契约版本自述 | `GET /meta` 的 `contractVersion` | 已实现 `fetchOpsMeta()` 与兼容判定 `checkContractCompatibility()`（`identity/contract-version.ts`）：MAJOR 不同或无法解析时阻止进入业务页，登录页显示升级提示。规则见契约 §2.1.1 |
