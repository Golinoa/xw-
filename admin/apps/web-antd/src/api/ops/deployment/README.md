# deployment 域（前端已实现，后端待交付）

契约：`Docs/ops-api-contract.md` §5.8 前半（`/api/v1/ops/deployments*`），数据模型 §3.7；
产品规则：PRD §6.8（私有化部署台账）、§8（状态规则）、§6.6（永久授权 ≠ 永久更新）。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `endpoints.ts` | 路径集中、静态 `VITE_OPS_MOCK` 判定、幂等键/写请求配置、列表参数白名单 |
| `types.ts` | 契约字段逐字对齐（`instance_no`→`instanceNo`、`maintenance_until`→`maintenanceUntil`） |
| `instances.ts` | 列表 / 详情 / 创建 / 编辑 / 状态流转 |
| `version-records.ts` | 升级历史读取 + 升级结果登记（**只有读与追加**，无 update/delete） |
| `rules.ts` | 状态动作表、维护期判定、升级登记前置校验、原因校验、固定文案（永久授权说明） |
| `errors.ts` | `code` + `details.reason` → 中文文案与可恢复性（含 `VERSION_MISMATCH`） |
| `format.ts` | 状态/部署类型/升级结果标签，维护期视图，日期与版本号格式化 |
| `dev-stub.ts` / `fixtures.ts` | `VITE_OPS_MOCK=true` 时的虚构契约桩（生产可 tree-shake） |

## 端点（契约 §5.8）

- `GET|POST /deployments`、`GET|PATCH /deployments/{deploymentId}`
- `POST|GET /deployments/{deploymentId}/version-records`

**契约推导端点**（§5.8 缺项，已在 journal 登记待确认）：

- `POST /deployments/{deploymentId}/transition`：§3.7 状态机有 `go_live` /
  `start_maintenance` / `end_maintenance` / `retire` 四个动作，但 §5.8 只给了 `PATCH`。
  按 customer/contract 域同一形态补 `transition`，**禁止**用 `PATCH` 直写 `status`。

**契约推导筛选**（§5.8 未列，需后端确认后才生效）：

- `deploymentType`：实例自有列，语义明确；
- `productId`：需服务端经实例关联授权聚合。后端未支持时该条件不生效，
  页面已在筛选处标注「契约推导」，避免让运营误以为已过滤。

## 实现要点

1. **状态不直写**：界面没有改 `status` 的入口；`PATCH` 的可编辑字段不含 `status` 与
   `currentVersion`，当前版本只能由升级登记推进。
2. **版本历史只追加**：`deployment_version_records` 仅 INSERT（契约 §3.7），
   `version-history.vue` 没有操作列，写错只能再登记一条更正记录。
3. **永久授权 ≠ 永久更新**：`format.ts: deploymentMaintenanceNotice()` +
   `rules.ts: PERPETUAL_NOT_PERPETUAL_UPDATE_NOTE`，由
   `views/ops/deployment/components/maintenance-banner.vue` 渲染；维护期状态与授权方式互不推导。
4. **维护期「今天」只用服务端日期**：`rules.ts: businessDateOf()` 把 `GET /meta.serverTime`
   折算为 `Asia/Shanghai` 业务日期；取不到时状态为 `unknown`（「无法判定」），
   绝不使用浏览器本地时钟（源码参考门 §5.4）。
5. **`VERSION_MISMATCH`**：`fromVersion` 必须等于实例当前版本；前端 `validateVersionRecordInput()`
   先拦，服务端 409 时页面刷新后重试，不用本地值覆盖。
6. 台账**不保存**任何远程登录凭据（契约 §3.7 禁用列清单）：UI 不提供输入项，
   fixtures 也不含主机名/IP/口令/安装包地址；升级登记文案明确「事后登记，不执行远程升级」。
7. 开发态数据通过 `VITE_OPS_MOCK=true` 的桩提供，页面渲染 `dev-data-notice.vue` 提示。
