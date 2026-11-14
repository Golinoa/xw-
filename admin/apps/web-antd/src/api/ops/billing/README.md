# billing 域（应收、收款、核销、退款）

契约：`Docs/ops-api-contract.md` §5.5（`/api/v1/ops/receivables|receipts|receipt-allocations|refunds`），数据模型 §3.4，权限 §4，错误码 §6。

## 结构

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 契约字段类型（严格照抄字段名，金额一律 `number`） |
| `money.ts` | 金额格式化与输入校验；所有比较/求和走「整数分 + BigInt」，只用于展示与提交前预校验 |
| `format.ts` | 状态标签、操作者/收款方式归一化、日期格式化 |
| `rules.ts` | 业务规则：职责分离、展期前置条件、核销超额校验、原因必填 |
| `errors.ts` | `OpsApiError` → 可渲染的错误视图（409 冲突必须提示「余额已变化，请刷新后重试」） |
| `endpoints.ts` | 端点清单、幂等键、列表参数白名单 |
| `receivables.ts` / `receipts.ts` / `refunds.ts` | 域 API 客户端（只做参数 → 端点 → 类型化响应） |
| `fixtures.ts` / `dev-stub.ts` | 开发态**虚构**数据与桩行为（`VITE_OPS_MOCK=true` 且非生产才加载） |

## 铁律

1. 金额只在展示层格式化（千分位 + 2 位小数），合计取服务端 `summary`；禁止 `parseFloat` 后计算再回写。
2. 收款必须由登记人以外的运营人员用 `receipt.approve` 审核，通过后才计入实收；前端在按钮层禁用并说明原因，服务端返回 403 `SEGREGATION_OF_DUTY`。
3. 冲正/撤销核销/退款只追加反向流水，**不改原收款记录**；页面必须展示「冲正记录关联原收款」。
4. 核销/冲正/退款/审核都是高风险动作：二次确认 + 必填原因 + 提交中防重复 + 失败保留输入与 `requestId`。
5. 无 `receivable.read` 时不展示任何金额（页面级拦截，不只靠路由守卫）。
6. 应收状态是派生值，前端不按日期自行推算逾期。
7. 开发态数据必须显示「开发态数据（虚构）」提示，绝不冒充真实集成。

## 待确认（详见 journal）

操作者/收款方式字段形态、列表多值筛选序列化（`status[]`）、`POST /receipts` 缺少 `recordedReason`、`GET /receipts` 未声明排序白名单、核销 `reason` 是否强制、跨对象账款明细端点缺失。
