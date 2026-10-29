# 订单编辑：金额行按 id 增量合并（2026-10-29）

## 今日完成

修掉上一轮明确留下的缺陷：`update_order_with_items` 把明细行整体删掉再插入，
插入只带 `name` / `amount`，于是 `confirmed_amount` / `pending_amount` 回落成 0。
**改一下线路名，客户已确认的 3000 元收款就没了，利润跟着变，且没有任何报错。**

- `packages/contracts/src/orders.ts`
  - 新增 `updateReceivableLineInputSchema` / `updatePayableLineInputSchema`：在创建用的
    schema 上扩展可选 `id`。创建请求的 schema **不含** id——新建时行还不存在，
    允许传 id 只会得到一次「看起来生效、实际被忽略」的空操作。
  - `updateOrderRequestSchema` 增加两条 refine：同一份请求里相同的行 id 不得出现两次。
- `supabase/migrations/20261029000006_order_line_upsert.sql`
  - 重写函数（签名不变，`CREATE OR REPLACE` 保留 ACL）：带 id 的原地更新、
    不带 id 的新增、请求里缺席的才删除。
  - 三道前置判定：行 id 必须属于本订单（`LINE_NOT_FOUND`）、
    新金额不得低于已确认 + 在途（`LINE_AMOUNT_CONFLICT`）、
    有收付款的行不得删除（`LINE_HAS_PAYMENTS`）。三条都在任何写入之前返回。
  - 补 `GRANT UPDATE (name, amount, updated_at)`：`order_receivables_update_writer`
    策略在 03 迁移里就写好了，列级授权却一直缺席，策略从未被用到。
    `confirmed_amount` / `pending_amount` 仍然不开放。
- `apps/api/src/modules/orders/*`：`OrderLineInput` 增加 `id`，`rpcBody` 透传；
  `OrderMutationError` 扩成 6 个码，`mutationFailure` 改成**白名单**——
  函数新增码时必须显式登记，否则会被当成 404 掩盖真因。
- `apps/web/src/views/orders/OrderFormModal.vue`：明细行带上 `id` 与 `paidAmount`；
  已有收付款的行**删除按钮直接禁用**，金额改到低于已收款在提交前就拦下。
- `apps/web/src/lib/api-client.ts`：两个新错误码的中文文案。

## 关键决策

**为什么不是「删了重建但把已确认金额一起搬过去」。** 那需要给客户端开放
`confirmed_amount` 的 INSERT 权限，等于任何人可以直接插入一条「已确认 999999」的行。
按 id 增量合并是唯一既不开放敏感列、又不丢数据的做法。

**为什么拒绝删除有收付款的行，而不是顺手删掉。** 重新拆分金额行（把「团款」拆成
「团款A + 团款B」）是真实业务需求，但正确做法是先处理款项，而不是让一次表单提交
静默销毁资金记录。当前返回 409 + `ORDER_LINE_HAS_PAYMENTS`，用户能看到原因。
这属于已知限制，等收付款流程（R-FIN-02/03）落地后再提供「转移/作废款项」入口。

**错误码分三档而不是一律 409。** 行 id 对不上是调用方的问题（400），
金额与已收款冲突是业务状态问题（409 且码不同），前端要靠码给出不同指引。

## 遇到的问题（都是我自己写错的，记录以备复犯）

1. **重复 id 检测形同虚设。** 初版用 `array_agg` 收集 id 再与「带 id 的行数」比对，
   但 `array_agg` 保留重复，两边永远相等。写测试时才发现，改成 `array_agg(DISTINCT ...)`。
2. **测试假设了订单 id。** `create_order_with_items` 自己生成订单 id，我却在断言里
   写死了一个「我以为的」id，导致首轮 12 条断言全挂在空行上。改成把真实 id 存进
   事务级 GUC（`set_config('test.main_order', ...)`）再引用。
3. **测试里把应付行删掉后又去引用它。** 改用第二张订单的行 id 做「别人的行」用例，
   比跨表冒充更贴近真实攻击面。

## 验证

- `pnpm db:local:verify`：11 个迁移从空库重放，**8 个测试文件 / 130 条断言全绿**。
  新增 `supabase/tests/order_line_update.sql` 共 23 条断言，核心几条：
  - 只改线路名后 `confirmed_amount` 仍是 3000（这就是回归本身）
  - 金额降到 2000（低于已确认 3000）返回 `LINE_AMOUNT_CONFLICT`，且什么都没写
  - 把该行从请求里去掉返回 `LINE_HAS_PAYMENTS`，行仍在
  - 另一张订单的行 id 返回 `LINE_NOT_FOUND`
  - 同一 id 出现两次返回 `LINE_DUPLICATE`
  - 无收付款的行可以正常删除，全序列结束后已确认金额仍是 3000
- 改写 `finance_scope.sql` 一条断言：原来断言「明细行不能原地改」，
  在新授权下已不成立；改为断言「`confirmed_amount` 客户端写不了」——
  这才是真正要守的不变式。
- 单测 34 文件 / 197 用例通过（新增 `orders.test.ts` 6 条、路由 5 条）。
- `format:check` / `format:sql:check`(20) / `lint`+CSS token / `schema:check`(11) /
  `check:deploy` / `typecheck` / `build` 全通过。

## 下一步

- 明细行的写入策略目前不看父订单状态，`completed` / `cancelled` 的订单行仍可被
  直连 PostgREST 增删改（API 层已挡）。这是本次之前就存在的口子，未在本轮修。
- 跨订单/全组织的财务合计、收付款申请与审批流（R-FIN-02/03）。
- 客户回收站、客户来源维护端点、标签管理 UI；`.vue` 仍无类型级检查。
