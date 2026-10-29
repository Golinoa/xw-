# support 域（已实现，开发态走契约桩）

契约：`Docs/ops-api-contract.md` §3.8（表/状态机/约束）、§5.8 后半（`/api/v1/ops/tickets*`）、§6（错误码）。
交付记录与推导项：`.harness/journal/2026-10-29-task7-support.md`。

已实现端点（`endpoints.ts` 是路径唯一出处）：

- `GET|POST /tickets`、`GET|PATCH /tickets/{ticketId}` —— `tickets.ts`
- `POST /tickets/{ticketId}/assign`、`POST /tickets/{ticketId}/transition` —— `transitions.ts`
- `GET /tickets/{ticketId}/timeline`、`POST /tickets/{ticketId}/events`、`POST /tickets/{ticketId}/references` —— `events.ts`

实现要点：

1. 时间线是不可变事实流：只有读取与追加，没有编辑/删除函数；任何状态推进都会产生事件。
2. 状态动作由 `rules.ts` 的 `ticketStatusActions()` 计算，非法迁移统一由服务端 409 `STATE_CONFLICT` + `details.allowedActions` 兜底；页面取本地与服务端的交集。
3. 工单引用必须属于同一客户，否则 400 `REFERENCE_CUSTOMER_MISMATCH`。
4. 逾期只读服务端 `isOverdue`（`format.ts` → `ticketOverdueView`），**禁止**用本地时间与 `dueAt` 比较。
5. 终态（`closed`）与重开必须填原因：`rules.ts` → `validateTicketAction()` 在发请求前拦截。
6. 开发态数据：`VITE_OPS_MOCK=true` 时走 `dev-stub.ts`（动态 import，生产摇掉），`fixtures.ts` 全部为虚构客户与虚构工单。
