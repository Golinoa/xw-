# contract 域（已实现）

契约：`Docs/ops-api-contract.md` §5.4（`/api/v1/ops/contracts*`），数据模型 §3.3 与同节状态机。页面：`src/views/ops/contract/`。

## 已实现端点

| 函数 | 方法与路径 |
| --- | --- |
| `fetchContracts` / `createContract` | `GET\|POST /contracts` |
| `fetchContract` / `updateContract` | `GET\|PATCH /contracts/{contractId}` |
| `transitionContract` | `POST /contracts/{contractId}/transition`（`submit`/`withdraw`/`sign`/`activate`/`terminate`/`expire`） |
| `fetchContractVersions` | `GET /contracts/{contractId}/versions` |
| `fetchContractEntitlementPreview` | `GET /contracts/{contractId}/entitlement-preview` |
| `createContractRenewal` | `POST /contracts/{contractId}/renewals` |
| `fetchContractAttachments` / `createContractAttachment` | `GET\|POST /contracts/{contractId}/attachments` |
| `fetchContractAttachmentAccess` | `GET /contract-attachments/{attachmentId}/access` |

未实现（本期页面不需要入口，仅登记）：`POST /contracts/{id}/amendments`、`POST .../amendments/{amendmentId}/transition`、`POST /contract-attachments/{attachmentId}/complete`。

约定：

1. `active`/`expired`/`terminated` 合同禁止 `PATCH`（409 `STATE_CONFLICT` + `CONTRACT_IMMUTABLE`），只能走变更单。
2. 合同金额由条目复算，前端只展示合计，**不提交**合计字段；条目必须显式选到价格版本。
3. 高风险动作（`contract.approve`，`CONTRACT_APPROVE_ACTIONS` = `sign`/`activate`/`terminate`/`expire`）：二次确认弹窗 + 影响摘要 + 必填原因 + 显式勾选，未通过校验不 `emit`，因此不会发请求。
4. 所有写操作带 `Idempotency-Key`（契约 §2.5），由 `createIdempotencyKey()` 生成，`crypto.randomUUID()` 不可用时降级。

## 页面

- `list.vue`：服务端分页 + 客户/状态/销售方式筛选，状态与生效/到期日展示。
- `create.vue`：草拟合同（客户、销售方式、条目行内选产品/套餐/价格版本、合计只读展示）。
- `detail.vue`：头颅信息、条目、版本快照、附件、应收与权益预览、状态迁移、续约入口。

## 开发态数据

`VITE_OPS_MOCK=true` 时走 `./mock` + `./fixtures`（4 份合同，覆盖 `active`/`draft`/`reviewing`/`expired`，含条目、附件、应收），页面顶部固定「开发态数据」提示条。桩内实现状态机、生效时写版本快照、`CONTRACT_IMMUTABLE`、续约窗口校验。

## 契约推导待确认项

1. **`ContractVersionEntry.snapshotSummary` 结构**：契约只给出字段名，未定义内部结构；当前按「版本列表需要展示的头摘要」取 `totalAmount`/`currency`/`itemCount`/`effectiveOn`/`expiresOn`，全部可选，缺字段不渲染。
2. **续约提前窗口 90 天**：契约只描述「未到期续约需业务确认」，未给天数；桩内用 90 天并返回 `RENEWAL_NOT_DUE`，需后端给出真实窗口与错误码。
3. **`ContractDetail` 的 `licenses`/`subscriptions`/`receivables`/`attachments` 是否随详情一次下发**：当前一次返回，若数据量大需拆端点。
4. **`sign`/`activate` 的日期字段**：`sign` 传 `signedOn`、`activate` 传 `effectiveOn`（`CONTRACT_ACTION_DATE_FIELD`），是否两个动作都允许显式改期待确认。
5. **`Idempotency-Key` 的重试语义**：契约要求写操作携带，未说明同一 key 复用窗口；前端每次提交生成新 key，失败重试需沿用同一 key，需后端确认。
6. **附件 `complete` 流程**：当前只做「创建附件记录 + 取访问地址」，若后端要求先直传再 `complete`，需要补一步。
