# entitlement 域（前端已实现，后端待交付）

契约：`Docs/ops-api-contract.md` §5.6（`/api/v1/ops/subscriptions|licenses|entitlement-*`），数据模型 §3.5。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `endpoints.ts` | 路径集中 + 静态 `VITE_OPS_MOCK` 判定 + 幂等键/写请求配置 + 列表参数白名单 |
| `types.ts` | 契约字段逐字对齐；`quota`（对应数据库 `quota_value`）只做类型与格式化 |
| `subscriptions.ts` | 订阅列表/详情/创建草稿/草稿期状态流转 |
| `licenses.ts` | 私有授权（同构）+ 永久授权期限约束 |
| `change-requests.ts` | 变更申请列表/详情/创建（订阅 & 授权）/transition |
| `snapshots.ts` | 快照按 id 查询 + 历史列表（**只有读**，无 update/delete） |
| `rules.ts` | 状态机动作表、审批人≠申请人、未审批不可执行、高风险判定、原因校验 |
| `errors.ts` | `code` + `details.reason` → 中文文案（含 409 `APPROVAL_REQUIRED`） |
| `format.ts` | 状态/类型/授权方式标签，额度与日期格式化 |
| `dev-stub.ts` / `fixtures.ts` | `VITE_OPS_MOCK=true` 时的虚构契约桩（生产可 tree-shake） |

## 端点（契约 §5.6）

- `GET|POST /subscriptions`、`GET /subscriptions/{id}`
- `GET|POST /licenses`、`GET /licenses/{id}`
- `POST /subscriptions/{id}/change-requests`、`POST /licenses/{id}/change-requests`
- `GET /entitlement-change-requests`、`GET /entitlement-change-requests/{id}`
- `POST /entitlement-change-requests/{id}/transition`（`approve`/`reject`/`execute`/`retry`/`cancel`）
- `GET /entitlement-snapshots/{id}`

**契约推导端点**（契约缺项，已登记 journal U-05/U-06）：

- `POST /subscriptions/{id}/transition`、`POST /licenses/{id}/transition`：仅 `submit`/`approve`/`reject` （§3.5 状态机前三行；生效后的状态推进一律走变更申请）。
- `GET /entitlement-snapshots`：快照历史列表；后端未提供时页面回退到详情 `snapshots[]` 并显式降级。

## 实现要点

1. **状态不直写**：界面没有「把状态改成 active/revoked」的入口；`active` 之后的暂停/恢复/撤销/到期只能「发起变更申请 → 审批 → 执行」，由服务端状态机推进。
2. **快照只增不改**：前端不提供编辑已发放权益；历史面板只有「查看明细」。
3. `execute` 返回 202 + `command{id,status}`，是异步命令，不能当同步结果用。
4. 永久授权（`license_mode='perpetual'`）不得推导出「永久更新」，维护期单独展示。
5. 审批人 ≠ 申请人：`requestedBy === 当前操作人` 时审批/驳回禁用并说明原因。
6. 未审批即执行：前端先拦（规则），服务端 409 `STATE_CONFLICT` + `APPROVAL_REQUIRED` 有可读提示。
7. 409 `CONFLICT`（版本冲突）→ 提示「数据已变化，请刷新后重试」并重新拉取，禁止本地覆盖。
