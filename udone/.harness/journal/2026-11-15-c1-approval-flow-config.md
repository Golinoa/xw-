# C1 审批流配置化（数据库层）

日期：2026-11-15 · 卡片：P9-C1（P0）· 出口：pgTAP 14 条断言，全量 32 个文件全绿

## 问题

级次与两个开关全部写死在 `20261029000008` 里：

- `current_step BETWEEN 1 AND 2`、`actions.step BETWEEN 1 AND 2`；
- 「第二级要求管理员」是硬编码的 `settings.manage` 判断；
- 同人审批一律禁止，注释写着「配置项落地后再改成开关」。

## 决策

1. **按机构配置**，不是全局。审批级次是机构自己的管理风格，跨机构共享没有意义。
2. **每级用「需要什么权限」表达，而不是「是哪个人/角色」**。角色是可叠加的
   （一个人可能既是 finance 又是 admin），权限才是一一判定的东西。
3. **配置在申请创建时快照进 `flow_snapshot`，引擎只读快照，永不回读配置表。**
   这是本卡唯一不可妥协的约束：改配置不得静默改变在途实例。
4. **旧行（无快照）按默认流程处理**，默认流程 = 配置化之前的 2 级，所以存量数据与
   存量测试的行为一字不变。
5. **`allowWithdraw = false` 用错误码 `WITHDRAW_NOT_ALLOWED`，不抛异常**。
   这是业务流程拒绝，不是权限问题；抛异常会让调用方把它当故障。

## 实现

`supabase/migrations/20261115000003_approval_flow_config.sql`

| 对象 | 作用 |
| --- | --- |
| `organization_approval_flows` | 机构配置：`steps`（1~3 级）、`allow_self_approval`、`allow_withdraw` |
| `default_approval_flow()` | 默认 2 级（财务 → 管理员），与改造前等价 |
| `effective_approval_flow(org)` | 配置行叠加默认值 |
| `finance_applications.flow_snapshot` + BEFORE INSERT 触发器 | 创建时固化 |
| `set_approval_flow(...)` | 配置写入入口，需 `settings.manage` |
| `decide_finance_application` | 改为按快照推进：级次总数、每级权限、同人开关都读快照 |
| `withdraw_finance_application` | 加 `allowWithdraw` 闸门 |

## 验证

`db:local:verify` → **32 个测试文件全绿**（40 个迁移）。新增 `approval_flow_config.sql` 14 条断言，
其中核心是这一对：

- 先按默认 2 级提交 → 把机构配置改成 3 级 → **那张已提交的申请快照仍是 2 级**，
  并且真的只用 2 级就终审通过；
- 之后新提交的申请才是 3 级，逐级走完 `pending/2 → pending/3 → approved`。

只断「新申请走 3 级」是不够的 —— 那样配置表直接覆盖旧行也能测绿。

另外覆盖：`allowWithdraw` 关时创建人撤回被拒、开时新申请可撤回；同人审批默认禁、
开关打开后放行（管理员自提自批）。

## 踩到的两个坑（留给下一个改这里的人）

1. **终审报错文案不能随便改**。`finance_application_flow.sql` 与
   `finance_payment_application.sql` 都用 `%administrator%` 匹配这条报错。
   配置化之后「终审」取决于最后一级的权限，但文案还是保留了
   `the final step requires an administrator (step N needs X)` —— 业务含义没变，
   顺带把真实需要的权限也带出来了。
2. **快照语义会「骗」测试**。把 `allowWithdraw` 改成 true 之后拿**旧申请**去撤回，
   仍然会得到 `WITHDRAW_NOT_ALLOWED`，因为快照在创建时就固化了。
   断言必须基于「开关打开后新提的申请」，否则测的是自己的误解。

## 未做

- 配置的读取/写入端点（`GET/PUT /api/v1/approvals/flow`）与设置页；
- 契约层没有 `ApprovalFlow` 的 zod schema（要等端点定下来再一起加，避免两处定义漂移）。

数据库已具备完整能力：配置可写、快照生效、引擎按快照推进、两个开关都有效。
