# identity-audit 域（前端已实现，后端待交付）

契约：`Docs/ops-api-contract.md` §5.1（meta/session/identity）、§5.9（overview/settings/exports）、数据模型 §3.9；权限动作目录 §4；PRD §4（账号与权限）、§5.10（字典）、§6.10（审计与导出）。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `endpoints.ts` | 路径集中、幂等键生成、写请求配置、查询参数剔除空值 |
| `session.ts` | `/meta`、`/session`、`/permissions` 与登录后的会话模型 |
| `contract-version.ts` | 契约版本兼容判定（MAJOR 不等或解析失败 → 阻断） |
| `operators.ts` | 成员列表 / 邀请 / 修改（幂等键必填） |
| `roles.ts` | 角色列表 / 创建 / 修改（幂等键必填） |
| `audit-events.ts` | 审计查询（**只有读**，审计由后端在动作发生时落库） |
| `overview.ts` | 总览指标与按币种金额 |
| `settings.ts` / `dictionaries.ts` | 三项系统设置、字典项增改（无删除，只有停用） |
| `exports.ts` | 导出任务列表 / 创建（异步 202）/ 详情（签名 URL） |
| `rules.ts` | 设置取值范围与「只提交改动项」、范围文案 |
| `format.ts` | 成员状态、导出状态/类型、审计动作、行为主体、时间与计数格式化 |
| `dev-stub.ts` / `fixtures.ts` | `VITE_OPS_MOCK=true` 时的虚构桩（生产可 tree-shake） |

## 端点（契约已列）

- `GET /meta`、`GET /session`、`GET /permissions`
- `POST /auth/login|refresh|logout`（§5.1 正式端点）
- `GET /operators`、`POST /operators/invitations`、`PATCH /operators/{operatorId}`
- `GET /roles`、`POST /roles`、`PATCH /roles/{roleId}`
- `GET /audit-events`
- `GET /overview`
- `GET|PATCH /settings`、`GET /dictionaries`、`POST /dictionaries/{code}/items`、 `PATCH /dictionary-items/{itemId}`
- `GET|POST /exports`、`GET /exports/{exportId}`

## 契约缺口（前端按「不猜、不伪造」处理，待后端确认）

| # | 缺口 | 前端现状 | 影响 |
| --- | --- | --- | --- |
| G-1 | `PATCH /operators/{operatorId}` 要求 `version` 必填，但 `GET /operators` 列表项**不含** `version`，也没有 `GET /operators/{operatorId}` 详情端点 | 列表项按可选字段读 `version`；缺失时**禁用编辑入口**并在页面说明「后端未返回乐观锁版本」 | 后端不补该字段则成员无法修改，且不会出现「伪造版本覆盖他人改动」 |
| G-2 | `GET /operators` 列表项不含 `mfaRequired` | 编辑弹窗按 `mfaRequired ?? false` 预填，并在未返回时提示「后端未返回当前值，修改前请确认」 | 可能把已开启 MFA 的账号显示为未开启 |
| G-3 | `GET /roles` 未列 `description` | 类型为可选，缺失时不渲染描述行 | 仅展示缺失，无功能影响 |
| G-4 | `GET /dictionaries` 的条目字段为 `{value,label,sortOrder,isActive}`，**没有 `id`**，而 `PATCH /dictionary-items/{itemId}` 需要条目 id | 按可选 `id` 读取；缺失时该行只读并提示原因 | 后端不补 `id` 则字典项无法编辑 |
| G-5 | `POST /exports` 只列 `exportType` / `filters`，但 §4 把 `export.create` 标为高风险动作（须填原因、写审计） | 前端在弹窗收集 `reason` 并随请求体提交（推导项 U-17） | 后端若忽略该字段，审计里将没有导出原因 |
| G-6 | `GET /overview` 的 `partialFailures[]` 未定义条目字段 | 按宽松形状读取（`section`/`code`/`message` 全可选），未识别键原样列出 | 后端定稿后需同步 `format.ts` 的渲染 |
| G-7 | `requestedBy` / `updatedBy` 未定义形状（表列为 uuid） | `OpsActorLike` 同时接受字符串与对象 | 避免把对象渲染成 `[object Object]` |
| G-8 | `retention.exportDays` 未给取值范围 | 只校验正整数，越界由服务端 400 拒绝 | 前端不编造上限 |

## 实现要点

1. **幂等键是必填参数**，由调用方在**打开表单时**生成一次并持有到提交结束。函数内生成会让「连点两次」变成两条独立记录，正是幂等键要防的情况。
2. **前端不直写终态**：成员状态、角色权限、导出状态都只能经端点推进；导出的 `status` 由后台任务推进，页面只读 + 手动刷新，不在浏览器里「等它完成」。
3. **审计只读**：`audit-events.ts` 没有写函数。要补一条审计，应当去改产生该动作的端点。
4. **金额只格式化不累加**：总览金额取服务端字段，按币种分组，不跨币种合并。
5. **未知枚举降级**：`未知(<原值>)`，审计未登记动作原样显示。
6. **契约桩不冒充集成**：`VITE_OPS_MOCK=false` 时整个 `dev-stub.ts` 连同动态 import 一起被 tree-shake；页面同时展示「开发态数据」提示。
