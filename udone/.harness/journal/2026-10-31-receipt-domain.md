# 2026-10-31 · billing 下半：收款、核销、退款（o-t08）

## 这一单元做了什么

`o-t08` 是整条线风险最高的一域：一次核销要同时改 `receipts` 的状态、多行
`receivables` 的余额、插入分配流水、写审计——四件事必须在一个事务里成立。
两个提交：

- `650c5ad` 四张表 + 十四个函数 + 81 条 pgTAP（含一次约束修正）
- `db6f811` 契约包 + 十个端点 + 35 条单测 + 28 条集成（含一次形状收口）

最终数字：28 迁移 / 21 个 pgTAP 文件 / 829 条断言；集成 13 文件 251 条；单测
51 文件 597 例；build 主 chunk 1,638.75 kB 无增长；deps:audit critical 0 /
high 0 / moderate 1 / low 0。13 道门禁一次全绿。

## 关键决策

### 1. 契约 §3.4 自相矛盾，选了能让两边都成立的那一支

表的约束写 `CHECK (allocated_amount BETWEEN 0 AND amount)`——说 `allocated` 是
**净额**；同一节的不变量 2 写 `allocated_amount + 本次 <= amount + reversed_amount`
——说它是**累计毛额**。两者不可能同时为真。

用净额，`reversed_amount` 永远是 0，那契约里 `reversed` 这个状态就不可达，
而且「全额核销 → 撤销一部分 → 重新核销」这条正常路径会撞 CHECK。
用毛额，两条式子都成立，`reversed` 也有了意义（核销被全部撤销）。

改约束为净额不变量：

```
0 <= reversed_amount <= allocated_amount
allocated_amount <= amount + reversed_amount
```

两条合起来就是 `0 <= allocated - reversed <= amount`，与契约的状态派生公式
`net = allocated - reversed` 严格等价。函数一行没改。契约正文待回写（C-109）。

### 2. 撤销核销累加 `reversed_amount`，不回退 `allocated_amount`

核销记录本身要保留（契约 §3.4「不覆盖原流水」），所以撤销是**另一条正数
流水**。「这笔钱核销过又被撤销」这件事只能靠两个数之差表达；直接减
`allocated` 会让那段历史消失。代价是 `allocated` 可能超过 `amount`——这正是
第 1 条要把 CHECK 换成净额不变量的原因。

### 3. 核销的顺序：先验形状、再验总额、再锁、最后逐期验

```
校验入站形状（金额 > 0、两位小数、同一期不重复）   ← 不查表
校验收款可分配额                                   ← 锁收款之后
按 id 排序锁全部应收                               ← 防死锁
逐期校验客户 / 币种 / 余额
落库 + 写审计
```

「同一期出现两次」必须在第一趟挡住：1000 的期收两笔 600，每笔单独看都
`<= 1000`，两笔一起就超额了。

按 `id` 排序加锁是刻意的：两个并发核销如果以不同顺序锁同一组应收，会互相
等成死锁；排序把「谁先谁后」变成确定的。

### 4. 职责分离两层，两层各自独立生效

应用层判 `recorded_by = actor` 回 `segregation_of_duty`（→ 403 +
`details.rule='SEGREGATION_OF_DUTY'`），表上是 `CHECK (approved_by IS NULL OR
approved_by <> recorded_by)`。两条都要：CHECK 只给得出 23514，说不出「为什么
不行」；只靠应用层，任何绕过端点的写入路径都能自审。

变异验证说明了它俩确实独立：把应用层判断改成 `if false`，测试**没有**返回
`segregation_of_duty`，而是在第 17 条断言之后中断于
`violates check constraint "receipts_segregation_of_duty"`——表约束接住了。

### 5. 可退额取自「已核销净额 − 未取消退款」

这样顺带挡住了「未审核的收款退款」：`recorded` 的收款核销净额为 0，可退额
就是 0，不需要再加一条状态判断。契约 §3.4 的原话是「累计退款额 ≤ 对应收款
已核销净额」，照字面实现即可。

### 6. 退满 → `refunded` 没有独立端点

契约的状态机有一条 `reconciled → refunded`（累计已审核退款额 = 收款额），但
端点表里没有对应动作。它由**最后一次退款审核**触发，所以这条边写在
`transition_refund` 的 approve 分支里。漏了就永远到不了 `refunded`，而「已
退款」这个筛选条件会一直返回空。

### 7. 完全重复与「仅同号」是两件事

契约 §5.5 同时要求：409 `CONFLICT`（同 `referenceNo` 重复登记）**和**
`duplicateWarnings[]`（同流水号）。两者分开：

- 同客户 + 同流水号 + 同金额 + 同日期 → 409。同一笔钱录了两遍。
- 仅流水号相同 → 201 + 警告。银行流水号在不同批次之间会重号，硬拒会逼财务
  把真实的第二笔改成假流水号才能入账。

### 8. 两个详情端点的核销形状收成一份

`GET /receivables/{id}` 上一轮用 `jsonb_agg(to_jsonb(entry))` 透传原始行
（snake_case），而同一个响应里的 `receivable` 是 camelCase。当时这么写是因为
两张表还不存在，没有形状可写。表一落地，透传就变成真实缺陷。

新增迁移 `20261031000005` 把 `allocation_json` / `reversal_json` 收成两个函数，
两个详情端点都调它。过滤方向相反（按应收 / 按收款），形状必须相同——否则前端
要为同一个列表写两套渲染。

### 9. 审计在本域第一次真正落库

契约 §6.1 把收款登记/审核/核销/核销撤销/退款列进「必填 reason」的高风险动作，
§6.4 又点名 `receipt.rejected` 这个词。前面四个域都只建了 `ops.write_audit`
却一处都没调用。本域落了九个词，`OPS_AUDIT_ACTIONS` 同步补齐——否则运营端的
审计筛选下拉里没有这些词，就成了「库里有、词表里没有」的另一半问题。

## 踩坑

### 1. 多列 CHECK 的自动名是表级的，按名字删会静默失败

`CHECK (allocated_amount BETWEEN 0 AND amount)` 引用了两列，Postgres **不会**
把它命名成 `receivables_allocated_amount_check`，而是回落成 `receivables_check`
/ `receivables_check1`（带序号，取决于建表顺序）。

`ALTER TABLE ... DROP CONSTRAINT IF EXISTS receivables_allocated_amount_check`
于是「成功地什么都没做」——`IF EXISTS` 连 NOTICE 都只是 skipping，不算错。
结果旧约束和新约束同时生效，净额不变量被打回原形，而且是**跑完迁移才看出来的**。

改成按定义找：

```sql
for entry in select conname, pg_get_constraintdef(oid) from pg_constraint
  where conrelid = 'ops.receivables'::regclass and contype = 'c'
loop
  if entry.definition like '%allocated_amount%' or ... then drop ...
end loop;
```

### 2. `psql -f` 不是单事务，迁移炸在半路会留下半个库

`replay` 用 `psql -v ON_ERROR_STOP=1 -f 文件`，没有 `-1`。迁移第 1200 行报
`type "ops.receipt_allocation" does not exist` 时，前面 1100 多行已经提交了。

于是下一次查询看到的约束里既有旧的两条、也有我新加的两条——我一度以为是
「DROP 没生效」，实际是「库停在中间态」。`replay` 每次都 DROP DATABASE，
所以正式流程不受影响；但排查时被这个状态误导了一轮。

### 3. 命名参数不能跳过没有默认值的参数

`ops.record_receipt(p_customer_id => …, p_transaction_date => …)` 省掉
`p_contract_id` 直接报 `function does not exist`——报错信息完全没提「你少传了
一个参数」，看起来像函数签名写错了。有默认值的才能省。给五处调用补显式 NULL。

### 4. `->>` 取出来已经是 text，不能连着再用一次

`ops.get_receipt(...) ->> 'receipt' ->> 'status'` 报
`operator does not exist: text ->> unknown`。两级取值一律 `->`，最后一次才
`->>`。

### 5. 第三次以 `authenticated` 直读业务表被拒

`permission denied for table receipts`。`ops.receipts` 等四张表都是 REVOKE +
RLS 双保险，业务身份连 SELECT 都没有。测试改为：以超级用户读一次把 id 存进
会话级 GUC（`set_config(..., false)`，跨 role 切换仍有效），读侧一律走 RPC。

这一课 o-t07 踩过、o-t12 又踩过，这次仍然在第一版里踩了——写测试时的肌肉记忆
是「查表拿 id」，而运营端的模型是「表不可读，只有 RPC」。

### 6. 集成测试的默认令牌是租户管理员，不是运营

`call(path)` 不传 `token` 时用的是 `USERS.admin`（租户身份）。三个 GET 忘了
传运营令牌，报 `An active operator account is required`——看着像权限配置错，
实际是测试拿错了身份。运营端点的每一次调用都要显式 `token: opsToken`。

## 未验证项

1. **真正的并发核销没测。** `for update` 与排序加锁是按契约写的，但 pgTAP 和
   集成都是串行执行——没有两个连接同时跑一笔核销。要证明「并发不超额」需要
   两个会话，本轮没有做。这是本域唯一一条「设计上正确、但没有证据」的结论。
2. **退款之后撤销核销。** 当前允许：`refundable` 会变成负数，后续退款被挡，
   收款仍停在 `refunded`。这违反 §3.4「累计退款额 ≤ 已核销净额」的字面约束，
   但从业务上看「钱已经退了，撤销核销不改变这个事实」也说得通。没有加守卫，
   登记为口径问题（C-111）。
3. **`ops.refunds` 没有职责分离。** 契约 §3.4 只给 `receipts` 加了
   `approved_by <> recorded_by`，退款表有同样的两列却没有这条 CHECK。没擅自
   补——小团队可能真是一个人经办（C-110）。
4. **`method` 的形状与 `refundableAmount` 是契约外新增。** 前者因为契约里
   列表项叫 `method`、查询参数叫 `methodCode`，字典落地后 label 才有意义；
   后者因为退款入口要显示「还能退多少」（C-112）。
5. **三个新 reason 词不在 §6.4**：`INVALID_TRANSITION`（合同域已在用）、
   `REVERSAL_EXCEEDED`、`CONTRACT_MISMATCH`（C-113）。

## 下一步

`o-t09` 订阅授权权益可以开工：`ops.settings` 已在（`overview.expiryWindowDays`
用于临期口径），billing 的收款链路已完整，权益的「发放即快照、不静默覆写」
与合同的 `contract_items` 是同一种形状。

`o-t10` 租户映射与 `o-t11` 部署台账之间有硬依赖（台账要引用实例），顺序不能
反。`o-t13` 总览要等这两域都落地才有完整的数字来源。
