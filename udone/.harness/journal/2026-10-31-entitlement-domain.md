# 2026-10-31 · 订阅 · 授权 · 权益快照（o-t09）

## 这一单元做了什么

`o-t09` 是整条线唯一一域**发给客户之后就改不动**的东西。订阅和授权是运营方的
意向，快照是已经发到客户手里的凭证——后者一旦被改写，客户侧看到的授权和运营侧
以为的授权就不一致，而且没有任何日志能证明谁改的（因为「改」这件事本身被绕过了）。

三个提交：

- `142343a` 五张表 + 二十六个函数 + 77 条 pgTAP（含一次约束补丁）
- `e52ba04` 契约包 + 十五个端点 + 25 条单测 + 33 条集成
- `9e4ac40` 额度键统一为契约的 `quota` + 一条钉住数值的断言

最终数字：29 迁移 / 22 个 pgTAP 文件 / 906 条断言；集成 14 文件 284 条；单测
52 文件 636 例；build 主 chunk 1,638.77 kB 无增长；deps:audit critical 0 /
high 0 / moderate 1 / low 0，白名单 0 条。13 道门禁全绿（`board:check` 在改完
`o-t09` 卡片与三条协作项之后才过——它检查的正是看板与实测数字是否一致）。

## 关键决策

### 1. 快照的不可变做了两层，因为只做一层挡不住「有权限的人」

REVOKE 挡住的是业务身份（`authenticated` 连 SELECT 都没有）；但表属主——也就是
跑迁移的那个人、以及任何拿到 `service_role` 的运维脚本——REVOKE 对他无效。
一条 `UPDATE ops.entitlement_snapshot_lines SET quota_value = 100` 会静默改掉已
发出的授权，而所有约束都满足。

所以加 `BEFORE UPDATE OR DELETE` 触发器直接 `raise`：

```sql
raise exception 'ops entitlement snapshots are append-only'
  using errcode = 'restrict_violation';
```

pgTAP V5 用 `23001` 证明：以表属主身份 UPDATE 也被拦。这条断言是本域里唯一
一条「证明的不是业务身份，而是我们自己」的断言。

### 2. `content_hash` 是幂等判据，不是校验和

契约让它 `UNIQUE(source_type, source_id, content_hash)`，同时要求同一内容重复
发放「不新建」。两件事只有一个实现能同时满足：**先算哈希、命中即返回既有行**。

哈希只覆盖语义四字段——`feature_key`、`enabled`、`quota_value`、`term_months`
——不含 `display_name_snapshot`。这不是偷懒：功能字典改名不等于授权变了，把
展示名算进哈希会让「改个中文名」变成一张新凭证，客户侧收到一条「授权已变更」
通知，实际什么都没变。

V7 证明这件事：改字典显示名后既有快照的 `display_name_snapshot` 保持旧值
（快照就是当时的证据），而 `create_snapshot` 返回的仍是同一个 id。

`diff.changed` 用同一口径（算之前先 `- 'display_name_snapshot'`）。否则会出现
「diff 说这一行变了，但哈希没变、也没发新快照」——两个函数对「变化」的定义不一致，
而这种不一致没人会主动去查。

### 3. 变更申请的基线是「当前快照」，不是「套餐权益」

这是最容易写错的一处。以套餐为基线时，客户单独加购的某项功能会在第一次额度
调整后**静默消失**：套餐里没有它，从套餐重建出来的行自然也没有它，而没有人
会注意到少了一行——`lineCount` 从 3 变 2，界面不报错。

```
before_lines := ops.snapshot_lines_json(current_snapshot_id)   ← 正确
before_lines := ops.feature_lines_base(package_id, scope)      ← 会丢加购项
```

变异验证：把前者改成 `'[]'::jsonb`，C3/C4/C5/C6 四条红（diff 变成「全部新增」、
after 只剩提案里的那一行）。

### 4. 未审批即下发回 `approval_required`，不是 `invalid_transition`

契约 §3.5 明确要求 `details.reason='APPROVAL_REQUIRED'`。这两个词的差别不在
语义精度，而在**用户下一步做什么**：「动作不合法」让人以为自己点错了按钮，
去翻状态机；「需要先审批」让人去催那个人。

变异验证：删掉 `approval_required` 分支，T3 一条红，其余 16 条绿。

### 5. 权限按**动作**判，不按端点判

`POST /subscriptions/{id}/transition` 一个端点承载六种动作，权限分三种：

```
submit                        → entitlement.request
approve / reject              → entitlement.approve
suspend/resume/revoke/mark_expired → entitlement.execute
```

端点级固定判一个权限时两种错都不报错：判 `request`，`approve` 会被 403（有权的人
批不了）；判 `execute`，`submit` 会被放行（没权的人能提单）。P4 用「同一个人对
不同动作得到不同结果」证这件事——只靠「有权限时通过、无权限时 403」验不出来，
因为那两种实现在那两条路径上都对。

### 6. 永久授权与有效期是「同真同假」

契约给的是 `CHECK((license_mode='perpetual') = (valid_to IS NULL))`。拆成两条
单边约束（`perpetual → valid_to IS NULL` 与 `term → valid_to IS NOT NULL`）看似
等价，实际漏掉 `term + valid_to IS NULL` 这一格——而 T-09 验收断言明确要求
这种组合回 400。L1–L3 三条把两个方向都钉住。

### 7. 部分唯一索引，不是全表唯一

`subscriptions_open_item_key` 与 `private_licenses_open_instance_key` 只在
**非终态**生效：

```sql
create unique index subscriptions_open_item_key on ops.subscriptions (contract_item_id)
  where status not in ('revoked', 'expired');
```

全表唯一会让「撤掉再重开」永久办不到，而换约、重新上线都是正常路径。反过来
不加索引，同一条合同条目能开两份有效订阅——两份快照、两个状态、两份计费依据。

### 8. `contract_items` 补 `UNIQUE(contract_id, id)`

订阅和授权都要断言「这条目属于这份合同」。原来只有 `PRIMARY KEY(id)`，跨合同
引用完全合法：拿 A 合同的条目在 B 合同下开订阅，能成。补复合唯一键后，复合外键
`(contract_id, contract_item_id)` 才有依托。

与 billing「收款与应收必须同客户同币种」是同一类问题：单看每个 id 都存在，
看它们之间的关系才不成立。

### 9. `suspend`/`resume`/`revoke` 回 202 且 `command: null`

契约写的是「返回 202 与 `command{id,status}`」，而 `ops.tenant_commands` 这张表
还不存在——它属于 o-t10。三种选择：

- 伪造一个 uuid：运营端会拿它去轮询，永远等不到结果
- 改成 200：o-t10 落地时把 200 改 202 是破坏性变更
- 202 + `command: null`：状态确实变了，租户侧确实还没同步——**这正是 202 的含义**

选第三个，并把偏差登记为 C-114。

### 10. 订阅审批不做职责分离，变更申请做

契约只给 `entitlement_change_requests` 加了 `CHECK(approved_by <> requested_by)`。
订阅本身没有这条——开通一份新订阅的「申请人」和「审批人」可以是同一个人，
因为没有第二个人知道这份订阅该不该存在。

变更则不同：它改的是一份已经在客户手里生效的凭证，「谁提的、谁批的」必须能
分开追。这处不对称是照契约实现的，不是遗漏（C-115 把这两侧的口径与 billing 的
C-110 放在一起，等产品一并裁决）。

## 踩坑

### 1. 合同详情的信封是扁平的，写成 `body.contract.items` 会静默拿到 undefined

`GET /contracts/{id}` 返回 `{ contract, items, receivableSummary, … }`——`items`
在**根上**，不在 `contract` 之下。测试里写成 `saasDetail.body.contract.items[0].id`
拿到 `undefined`，于是后面每一次 `contractItemId: undefined` 都被 zod 挡成
400 `invalid_type`。

症状离原因极远：27 条用例红，报错五花八门（`expected 0 to be >= 1`、
`Cannot read properties of undefined`），而真正的错只有一行。教训是**先跑单条
拿第一条红**，别顺着尾巴猜——尾巴上那些 90% 是级联。

### 2. `finance_ops` 在角色种子里只有 `entitlement.read`，没有 `entitlement.request`

测试里写「财务提单、管理员批」，跑到那里直接 403——因为财务根本提不了单。
补了一个 `sales_ops` 账号（有 `request`、无 `approve`），「换个人审批放行」
这条正路才真的在 RLS 上跑起来。

这件事本身也说明了一个测试通病：**用管理员一个人走完所有步骤**，看起来
「权限都验过了」，实际上职责分离那一段一次都没被执行。

### 3. `expect([403, 404]).toContain(response.status)` 什么都没证明

原句想表达「财务有 `entitlement.read`，所以应该到 404 而不是 403」。写成数组
包含之后，权限检查退化成 403 它也会通过——两种截然不同的行为收进了同一条断言。

改成只断言 404：财务账号**有** read 权限，能过权限门，只是那一行不存在。

### 4. 只断言 `lineCount` 数不出额度丢失

快照明细两条，断言 `lineCount === 2` 通过。但如果入站键名写错（`quota` 读成
`quotaValue`），额度会被静默丢弃，行还是两行——`enabled` 有值、`quota` 是 null，
`lineCount` 照旧是 2。

补断言要按 `featureKey` 取行、断言**数值**：`quota: 10`。变异验证（把出站映射
改成 `quota: null`）时，「详情带明细行」与「提变更单 diff」两条红——
`snapshot_json` 与 `snapshot_lines_json` 两个出站函数都被覆盖到。

### 5. 命名参数不能跳过没有默认值的参数

`ops.create_license(p_customer_id => …, p_contract_item_id => …, p_license_mode => …)`
跳过 `p_deployment_instance_id` 报 `function does not exist`。报错完全没提「少传了
一个参数」，看起来像签名写错了。

`create_license` 的 `p_deployment_instance_id` / `p_license_mode` / `p_valid_from`
全部补 `DEFAULT NULL`，并补 `valid_from_required` 守卫——否则「省略」会变成「传了
NULL 但没校验」。

### 6. 四条列表路由的 `request` 是空的，契约却写了查询参数

`defineRoute` 是恒等函数，漏挂 `request` 不会报错、不会红，只是**契约没有描述这个
端点接受什么参数**。前端照契约传 `status[]` / `expiringInDays` / `productId`，
而契约本身对这四个端点一个字都没说。

是 lint 发现「import 了四个 schema 却没用」才暴露出来的。补齐后 `route-parity`
与单测都过——**lint 的 unused-import 在这里起的是契约完整性检查的作用**，纯属
运气好。

### 7. `plan(N)` 与实际断言数不符是常态

删掉两条占位断言后编号断档（C17 变 C16），`plan` 没同步。计数用
`grep -cE "^  (IS|ok|throws_ok|matches) *\("`，与 `plan()` 一起改。

顺带清掉两处 `'S13b placeholder'` / `'C16 placeholder'`——占位断言比没有断言更糟，
它让 `plan` 的数字看起来是对的。

## 未验证项

1. **租户同步一次都没跑过。** `command` 恒为 `null`，`ops.tenant_commands` 表还
   不存在。三个高风险管理动作（`suspend`/`resume`/`revoke`）在本域只改了本地状态，
   「客户侧真的停了吗」没有任何证据（C-114，o-t10 落地后必须补一条端到端）。
2. **并发开订阅没测。** `subscriptions_open_item_key` 与
   `private_licenses_open_instance_key` 是部分唯一索引，理论上并发下也只会成一条，
   但 pgTAP 与集成都是串行——两个连接同时 POST 没跑过。
3. **快照只增不减，没有保留策略。** 变更单一创建就落一张 `proposed` 快照，被驳回
   与被取消的也留着，且 `BEFORE UPDATE OR DELETE` 触发器让任何人都删不掉——
   包括运维清理脚本。按月的变更频率算，一年后这张表会以每客户每月 N 行增长，
   而 `list_entitlement_snapshots` 每次都按主体扫（C-116）。
4. **审批人是单点。** 角色种子里只有 `platform_admin` 有 `entitlement.approve`。
   若某个客户侧只有一个运营账号（同一个人既提单又审批），任何变更单都过不去——
   这是 `CHECK(approved_by <> requested_by)` 的必然后果，业务上正确，但要确认
   组织形态是否接受（C-115）。
5. **订阅审批没有职责分离**（见关键决策 10）：契约没要求，实现照契约。若复核
   认为订阅开通也该两人，需要加 CHECK 并回写契约。
6. **`before_summary` / `after_summary` 是快照行的全量副本。** 契约只要求「前后值
   摘要」，实现存了完整行（含展示名）。好处是详情页不用回查快照；代价是同一份
   数据在库里存三份（快照、before、after）。变更单数量大时需要重新评估。

## 下一步

`o-t10` 租户映射：`tenant_commands` 一落地，本域三个 202 端点的 `command` 就能
从 `null` 换成真实对象，C-114 随之关闭。它与 `o-t11` 私有化部署台账有硬依赖
（台账要引用实例），顺序不能反。
