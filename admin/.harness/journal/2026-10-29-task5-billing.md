# 2026-10-29 Task 5：账款（应收 / 线下收款 / 核销 / 退款）前端

- 工作树：`D:/MYC/Coding/ERP-ops`，分支 `feat/ops-console`
- 范围：`admin/apps/web-antd` 的 billing 域（仅前端）
- 契约真源：`Docs/ops-api-contract.md` §2（金额精度）、§3.4（数据模型/状态机）、§4（动作码/高风险清单）、§5.5（端点）、§6（错误码与 `details.reason`）
- 产品依据：`Docs/PRD.md` §6.5、§7、§8、§10.3；实施计划 Task 5「负责人默认规则（2026-10-06）」
- 写入边界：`views/ops/billing/**`、`api/ops/billing/**`、`router/routes/modules/billing.ts`、本 journal

## 0. 结论速览

- 前端 billing 域**完整落地**：应收计划（列表/详情/生成/展期）、线下收款（登记/列表/详情）、审核（职责分离）、核销（跨应收分配 + 超额拦截）、撤销核销、收款冲正、退款登记与审核、账款明细流水。
- 三条金融正确性规则的落点见 §3，均有单测覆盖（71 条域内用例）。
- 后端 ops billing API 尚不存在：`VITE_OPS_MOCK=true` 时走 `api/ops/billing/dev-stub.ts`（虚构数据、复刻服务端拒绝路径），页面顶部显示「开发态数据（全部为虚构…）」提示；默认 `VITE_OPS_MOCK=false`，页面会诚实进入错误态而不是假装成功。
- 三条验收命令：`typecheck` ✅、`lint:check` ✅；`test:unit` 默认并发下 ⚠️——1 条边界外超时（`api/__tests__/stub-contract.test.ts` 认证桩，5s 默认超时、单文件实际 2.1s），`--maxWorkers=2` 下 23 文件 / 171 条全绿；billing 域单独 7 文件 / 73 条全绿（见 §6）。

## 1. 环境

| 项 | 值 |
| --- | --- |
| Node | `v24.20.0`（`export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"`） |
| pnpm | `10.33.4`（`corepack pnpm`） |
| 工作目录 | `D:/MYC/Coding/ERP-ops/admin` |
| 测试运行器 | `vitest 4.1.7`（`--dom`，happy-dom） |

## 2. 改动清单

### 2.1 新增：域 API（`src/api/ops/billing/`）

| 文件 | 说明 |
| --- | --- |
| `types.ts` | 契约字段类型：`Receivable`/`Receipt`/`Refund`/`ReceiptAllocationLine`/`BillingReversalLine`/`ReceivableExtension` 等；金额一律 `number` |
| `money.ts` | `formatAmount`/`formatMoney`/`formatAmountText`/`parseAmountInput`/`sumAmountStrings`/`subtractAmounts`/`compareAmountStrings`；比较与求和全部走整数分 + `BigInt` |
| `format.ts` | 状态标签与颜色（未知枚举降级 `未知(x)`）、`actorId`/`actorName`/`methodLabel` 归一化、日期格式化 |
| `rules.ts` | `canReviewReceipt`（职责分离）、`canExtendReceivable`（未结清才可展期）、`canAllocateReceipt`/`canReverseReceipt`/`canRefundReceipt`/`canReverseAllocation`、`validateReason`、`checkAllocations` |
| `errors.ts` | `describeBillingError`：`code` + `details.reason` → 标题/说明/`requestId`/`shouldRefresh` |
| `endpoints.ts` | 端点清单、`createIdempotencyKey`、`writeConfig`（注入 `Idempotency-Key`）、`buildListParams`（参数白名单，`status[]` 字面量） |
| `receivables.ts` | `fetchReceivables`/`fetchReceivable`/`createReceivablePlan`/`extendReceivable` |
| `receipts.ts` | `fetchReceipts`/`fetchReceipt`/`createReceipt`/`transitionReceipt`/`allocateReceipt`/`reverseReceipt`/`reverseAllocation` |
| `refunds.ts` | `fetchRefunds`/`createRefund`/`transitionRefund` |
| `fixtures.ts` | 虚构客户/合同/应收/收款/核销/冲正/展期/退款数据（名称含「虚构」） |
| `dev-stub.ts` | 开发态桩行为，复刻 403 `SEGREGATION_OF_DUTY`、409 `RECEIPT_NOT_APPROVED`/`RECEIPT_EXCEEDED`/`RECEIVABLE_EXCEEDED`/`HAS_ALLOCATIONS`/`RECEIVABLE_SETTLED`、乐观锁 `CONFLICT` |
| `index.ts` | 域出口 |
| `README.md` | 由「未实现」更新为已实现说明 + 铁律 + 待确认项 |

### 2.2 新增：页面（`src/views/ops/billing/`）

| 文件 | 说明 |
| --- | --- |
| `receivables.vue` | 应收列表（服务端分页/筛选 + 服务端 `summary` 四卡片）、详情抽屉（核销流水/展期历史）、生成计划弹窗（多期、金额字符串校验）、展期弹窗 |
| `receipts.vue` | 收款列表（状态含「计入实收/不计入实收」）、登记弹窗、详情抽屉入口 |
| `refunds.vue` | 退款列表、登记退款（选择原收款 + 可退款净额上限）、审核/取消退款 |
| `ledger.vue` | 账款明细：按应收/收款查看完整流水（时间/事件/操作者/金额/原因/关联对象） |
| `components/dev-data-notice.vue` | 「开发态数据（虚构）」提示（仅 `VITE_OPS_MOCK=true` 渲染） |
| `components/high-risk-modal.vue` | 通用高风险二次确认弹窗（金额/对象/影响摘要 + 必填原因 + requestId） |
| `components/allocation-modal.vue` | 核销分配：候选应收（同客户/同币种/未结清）、逐行金额、实时「可分配余额/本次合计」、超额拦截 |
| `components/receipt-detail-drawer.vue` | 收款详情与全部动作（审核/驳回/核销/退款/冲正/撤销核销）+ 冲正关联原收款展示 |
| `composables/use-high-risk-action.ts` | 高风险提交状态机：`prepare` 不发请求、`confirm` 校验原因、`submitting` 防重、失败保留输入 |
| `timeline.ts` | 流水事件拼装（`buildReceiptLedger`/`buildReceivableLedger`），纯函数可测 |
| `__tests__/{money,rules,errors,high-risk-action,timeline,dev-stub,receipt-approve-button}.test.ts` | 73 条用例（含 2 条真实挂载收款详情抽屉的组件测试） |

### 2.3 修改

| 文件 | 说明 |
| --- | --- |
| `src/router/routes/modules/billing.ts` | 新增 `/billing/refunds`（退款与冲正）、`/billing/ledger`（账款明细）子路由；authority 统一 `receivable.read` |

## 3. 三条规则的落点

### 3.1 金额精度（不在前端做加减乘除）

| 落点 | 说明 |
| --- | --- |
| `api/ops/billing/money.ts#formatAmount` / `#formatMoney` | 千分位 + 固定 2 位小数 + 负数符号；`null`/非有限数显示 `—`，不当 0 |
| `api/ops/billing/money.ts#parseAmountInput` | 字符串 + 正则校验（≤2 位小数、>0、≤999,999,999,999.99），通过后才做**一次**字面量转换 |
| `api/ops/billing/money.ts#sumAmountStrings` / `#subtractAmounts` / `#compareAmountStrings` | 整数分 + `BigInt`，**只用于展示与提交前预校验** |
| `views/ops/billing/receivables.vue`（`summary` ← `fetchReceivables().summary`） | 页面四张合计卡全部取自服务端 `summary`，不累加明细 |
| `views/ops/billing/components/allocation-modal.vue#allocatableText/#enteredTotal` | 两个唯一的前端派生值：可分配余额（`amount - allocatedAmount`）与本次录入合计（用户输入行求和），均在 UI 上标注口径，服务端仍会再校验 |
| `api/ops/billing/dev-stub.ts#toReceivable` | `outstanding` 由桩按整数分计算，模拟服务端口径 |

### 3.2 登记人 ≠ 审核人

| 落点 | 说明 |
| --- | --- |
| `api/ops/billing/rules.ts#canReviewReceipt` | 判定顺序：权限 → 身份 → 状态 → `actorId(recordedBy) === currentOperatorId` → `code: 'segregation_of_duty'` |
| `views/ops/billing/components/receipt-detail-drawer.vue#reviewDecision` | 审核/驳回按钮 `:disabled="!reviewDecision.allowed"`，Tooltip 与 `data-testid="receipt-sod-note"` 文案说明「登记人不能审核自己登记的收款」 |
| `views/ops/billing/components/receipt-detail-drawer.vue#actualIncomeNote` | 明确「未计入实收（等待他人审核）」/「已计入实收」；列表页也标注 |
| `api/ops/billing/dev-stub.ts#stubTransitionReceipt` | 桩复刻 403 `FORBIDDEN` + `details.reason='SEGREGATION_OF_DUTY'` |
| `__tests__/rules.test.ts`「审核收款：登记人 ≠ 审核人」 | 含 `{id,displayName}` 对象形态、换人可审核、无权限、状态不可审核 |

### 3.3 冲正/撤销不覆盖原记录

| 落点 | 说明 |
| --- | --- |
| `api/ops/billing/receipts.ts#reverseReceipt` / `#reverseAllocation` | 只有「追加反向流水」两个写端点，**不存在**修改收款金额的 API 路径 |
| `views/ops/billing/components/receipt-detail-drawer.vue`「冲正与撤销流水」区块 | 顶部提示「原收款金额 ¥X 保持不变；冲正与撤销以独立反向流水记录，并关联原收款 RC-…」，`关联对象` 列显示原收款 + 核销流水号 |
| `views/ops/billing/timeline.ts#buildReceiptLedger` | 冲正生成独立事件（`kind: 'receipt_reversal'`），`related` 含「原记录未修改」；不修改登记/审核事件 |
| `api/ops/billing/dev-stub.ts#stubReverseReceipt` / `#stubReverseAllocation` | 只 push 反向流水 + 改状态，不改 `amount` |
| `__tests__/timeline.test.ts` | 断言冲正事件关联原收款、原金额字段不变 |

## 4. 状态覆盖

| 页面 | loading | empty | error | validation | permission-denied | conflict | destructive-confirm |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `receivables.vue` | Table `loading` + 详情 `Spin` | `Empty`「当前筛选条件下没有应收记录」 | `Alert` + 重试 | 生成计划逐字段错误 / 展期原因与日期校验 | 页级 `Alert`（缺 `receivable.read` 不渲染任何金额）+ 生成/展期按钮禁用+Tooltip | 409 → `describeBillingError` + `shouldRefresh` 时重新拉取 | 展期弹窗（原因必填、只追加记录） |
| `receipts.vue` | Table `loading` | `Empty` | `Alert` + 重试 | 登记表单字段校验 | 登记按钮禁用 + 页级拦截 | 重复流水号 `duplicateWarnings`；409 刷新并重拉 | 登记弹窗 + 详情内高风险确认 |
| `receipt-detail-drawer.vue` | `Spin` | 三类流水各自 `Empty` | `Alert` + 重试 | 退款/撤销金额上限校验 | 各动作按钮按权限禁用 + 说明 | 409「余额已变化」+ 刷新 | `HighRiskModal`（摘要 + 原因 + 防重） |
| `refunds.vue` | Table `loading` | `Empty` | `Alert` + 重试 | 退款金额/日期/原收款校验 | 登记与审核按钮禁用 | 409 `REFUND_EXCEEDED` 映射 | `HighRiskModal` |
| `ledger.vue` | `Spin` | `Empty`「请选择左侧对象…」 | `Alert` | — | 页级拦截 | — | — |

## 5. 契约推导待确认项

| # | 事项 | 当前处理 | 需要的确认 |
| --- | --- | --- | --- |
| C-01 | `recordedBy`/`approvedBy`/`allocatedBy`/`createdBy` 是 id 还是 `{id,displayName}` | `format.ts#actorId/#actorName` 双形态兼容 | 建议统一返回 `{id,displayName}`，否则「操作者」列只能显示 id 前 8 位 |
| C-02 | `method` 响应形态（过滤字段是 `methodCode`） | `format.ts#methodLabel` 兼容 `string` 与 `{code,name}` | 建议返回 `{code,name}`，并补 `GET /dictionaries` 的收款方式字典（前端暂用 4 个线下方式常量） |
| C-03 | 多值筛选序列化：契约写 `status[]` | `endpoints.ts#buildListParams` 按字面量发 `status[]=a&status[]=b` | 确认后端接受 `status[]` 还是 `status` 重复键 |
| C-04 | 收款「可分配余额」无直接字段 | 前端 `amount - allocatedAmount` 整数分推导，UI 标注口径 | 建议 `GET /receipts` 增加 `allocatableAmount`，避免前端派生 |
| C-05 | `POST /receipts` 请求体未列 `recordedReason`（表有 `recorded_reason` 列） | 前端**不提交**该字段（避免严格 zod 400），登记弹窗已移除该输入 | 确认是否补 `recordedReason?`；不补则登记说明无法留痕，与 PRD §6.5「记录登记人」审计意图有缺口 |
| C-06 | `GET /receipts`、`GET /refunds` 未声明 `sort` 白名单 | 只发 `order`，不发 `sort`（应收列表按契约白名单发 `dueDate`） | 确认收款/退款的排序字段白名单 |
| C-07 | 核销 `reason` 契约标为可选（§5.5 `reason?`），Task 5 要求高风险动作必填原因 | 前端**强制必填** | 后端也应强制，否则前端约束可被绕过 |
| C-08 | `BillingReversalLine` 未列 `receiptId` | 前端用可选 `receiptId` 表达「冲正关联原收款」 | 建议详情响应返回该字段（否则只能靠嵌套上下文推断） |
| C-09 | 退款状态集 | 取契约 §11 U-03：`recorded/approved/cancelled` | 若新增 `completed`（线下到账确认），需同步页面与状态机 |
| C-10 | 无跨对象「账款明细」端点 | `ledger.vue` 按对象聚合 `GET /receivables/{id}`、`GET /receipts/{id}` 的流水 | 若产品要求全局流水/导出，需新增 `GET /ledger`（含分页与筛选） |
| C-11 | 客户/合同选择器缺失（客户域、合同域并行开发中） | 账款页面使用「客户 ID / 合同 ID」精确输入并注明「选择器待联调」 | 待客户/合同域提供搜索端点或共享选择组件 |
| C-12 | 设计文档 §2.4 提到 `receipt.read`，契约 §4 无此动作码 | 所有账款路由统一 `receivable.read` | 若确需独立收款读权限，须先改契约 §4 + 权限目录 |
| C-13 | 路由标题 i18n | 新增两项用中文字面量（`locales/*/ops-shell.json` 不在本任务可写范围） | 由共享文件负责人补 `menu.billingRefunds`/`menu.billingLedger` |

## 6. 验收结果（真实输出，2026-10-29 21:07–21:11 重跑）

### 6.1 `corepack pnpm --filter @vben/web-antd typecheck` ✅

```
> @vben/web-antd@5.7.0 typecheck D://MYC//Coding//ERP-ops//admin//apps//web-antd
> vue-tsc --noEmit --skipLibCheck

EXIT=0（无诊断输出）
```

### 6.2 `corepack pnpm --filter @vben/web-antd test:unit` ⚠️ 默认并发下有 1 条边界外超时

默认并发（真实输出）：

```
 Test Files  1 failed | 22 passed (23)
      Tests  1 failed | 170 passed (171)
   Duration  13.43s
```

唯一失败点**不在 billing 域**：

```
FAIL src/api/__tests__/stub-contract.test.ts > 开发态契约桩（VITE_OPS_MOCK=true） > 登录只接受桩账号，其它口令返回 401 凭据错误
（5000ms 默认超时；该用例单文件独占 CPU 时耗时 2117ms）
```

限制并发后复跑（`vitest run --dom --maxWorkers=2`）全绿：

```
 Test Files  23 passed (23)
      Tests  171 passed (171)
   Duration  29.26s
 EXIT=0
```

billing 域单独复跑（`vitest run --dom src/views/ops/billing`）：

```
 ✓ money.test.ts (11)  ✓ timeline.test.ts (8)  ✓ rules.test.ts (28)
 ✓ errors.test.ts (10) ✓ high-risk-action.test.ts (6) ✓ dev-stub.test.ts (8)
 ✓ receipt-approve-button.test.ts (2)
 Test Files  7 passed (7)
      Tests  73 passed (73)
   Duration  7.86s
```

### 6.3 `corepack pnpm run lint:check` ✅

```
EXIT=0（无 error / warning 输出）
```

billing 域 scoped 复验（并行域已全部清零后仍单独复核）：

```
npx oxlint --threads=2 apps/web-antd/src/views/ops/billing apps/web-antd/src/api/ops/billing
Found 0 warnings and 0 errors.   (29 files, 226 rules, 1.4s)

npx eslint apps/web-antd/src/views/ops/billing apps/web-antd/src/api/ops/billing \
  apps/web-antd/src/router/routes/modules/billing.ts --ext .ts,.vue
（无输出，退出码 0）
```

## 7. 需要 leader 知道的风险

1. **全量单测在默认并发下存在跨域超时**：`src/api/__tests__/stub-contract.test.ts`（认证桩，Task 3 负责人）单文件耗时 2.1s，在 23 文件并行 + 多专家同时跑门禁时超过 vitest 默认 5s 超时；`--maxWorkers=2` 下 171/171 全绿，billing 域单独 73/73 稳定通过。属测试耗时预算问题，不在本任务边界内，建议由该文件负责人显式声明 `timeout` 或降低并行度，否则合流门禁会间歇性变红。
2. **契约形态未定的三处（C-01/C-02/C-04）**：前端做了双形态归一与精确推导，但「可分配余额」是**前端派生值**，不是权威口径；真正的判定依赖服务端事务返回的 409。若后端最终字段不同，改动集中在 `format.ts` 与 `allocation-modal.vue`，不影响业务语义。
3. **登记说明无法留痕（C-05）**：契约 `POST /receipts` 没有 `recordedReason` 字段，前端已按契约不提交；若审计需要「为什么这笔钱在账上」的说明，必须由后端补字段，属金融可追溯性缺口，建议在本迭代内确认。
