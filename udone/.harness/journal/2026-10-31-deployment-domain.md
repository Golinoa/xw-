# 2026-10-31 · 私有化部署台账（o-t11）

## 这一单元做了什么

`o-t11` 是 ops 线第一域**把「当前状态」与「历史」拆成两张表**的东西。

前面九个域里，`status` 列既是当前状态、又是唯一的历史来源——合同从 `signed`
走到 `terminated`，中间发生过什么只能靠审计事件倒推。部署不是这样：「这台
机器现在跑哪个版本」和「它是怎么升到这个版本的」是两个问题，而且**后者
的可信度决定了前者的可信度**。所以两张表：

```
deployment_instances        当前结论（current_version 是一列，会变）
deployment_version_records  每次升级的登记（只 INSERT，属主也改不了）
```

一个提交：`2c24b3a` 两张表 + 十二个函数 + 80 条 pgTAP + 契约包 + 七个端点 +
30 条单测 + 24 条集成。

最终数字：31 迁移 / 24 个 pgTAP 文件 / 1059 条断言（本域 80）；集成 16 文件
336 条；单测 54 文件 695 例；build 主 chunk 1,638.77 kB 无增长（本域没碰前端）；
`deps:audit` critical 0 / high 0 / moderate 1 / low 0；许可 349 组。13 道门禁全绿。

## 关键决策

### 1. `current_version` 的唯一入口是「登记一条 succeeded」

契约 §5.8 的 PATCH 只说「可编辑字段」，没列清单。`currentVersion` 看起来完全
是该可编辑的——它就在那张表上，类型也普通。**但一旦可 PATCH，这个域就只剩一层
纸**：

`from_version` 必须等于当前版本（T-11 唯一一条拒绝断言）是这条链的全部守卫。
如果当前版本能直接改，绕法是两步：先 PATCH 到 `1.6.0`，再登记一条
`1.6.0 → 1.6.0` 的「升级」。两条都合法，历史却成了装饰——原来的 1.5.0 到
1.6.0 到底升没升过，再也没有东西能回答。

所以 `current_version` 只能由「登记 + `succeeded`」推进。建实例时仍可给初始值
（那是 baseline，不是修改）。单测用「请求体带 `currentVersion` 被 400」钉住：
契约包里的 PATCH schema 是 `strictObject`，多余的键直接拒——不是静默丢弃，
是让调用方知道这个字段不存在。

### 2. 只有 `succeeded` 推进，`rolled_back` 尤其不能

`failed` 不动是显然的。`rolled_back` 不动容易被写错——**回滚成功的定义就是
「还停在 `from_version`」**。把 `current_version` 写成 `to_version`，等于宣布
「回滚之后跑的是我们刚刚回滚掉的那个版本」。

写错的代价不在这一域：`current_version` 是三个下游的依据——维护到期提醒
（按版本算支持窗口）、授权关联（`licenses[]` 的摘要）、工单里「影响版本」。
写错一次三处一起错，而且每一处都不会报错。

变异：`if p_result = 'succeeded'` 改成 `<> 'rolled_back'`，R8 / R9 / R10 / R12 /
V1 / V2 / V9 / U4 / U5 等十条红。复原复绿。

### 3. 当前版本为 NULL 时不比对：第一条记录就是基线

契约 §5.8 把建实例的 `currentVersion` 标成**可选**。如果 `from_version` 的比对
按「NULL 匹配不上任何值」硬判，这类实例永远登不上第一条升级记录——而契约没留
别的路（没有「设置初始版本」端点）。

所以守卫写成 `target.current_version is not null and target.current_version <>
from_version`。R 组的第二台实例专验这条：建的时候不带版本，第一条记录
`0.9.0 → 1.0.0` 直接接受，成功后 `current_version` 变成 `1.0.0`。

这里有个反直觉的后果，写进了未验证项：**「没有基线」与「基线刚好是空的」在
数据上无法区分**，所以一台从没登过记录的机器，第一次登记什么版本都会被接受。

### 4. `last_reported_at` 是派生值，不落列（D-04）

契约 §5.8 的响应里有 `lastReportedAt`。加一列需要一条上报链路——实例自己
定期打点——而这条链路不存在。那种列只会一直是 NULL，比没有更糟：前端会拿它
当「最近一次心跳」，然后在一个永远空着的字段上做「n 天未上报」的告警。

实现取「最近一条版本记录的 `created_at`」，没有记录时是 `null`。代价是一台
三个月没升级的、运行完全正常的机器，看起来像「三个月没上报」——这一点在
列头口径里写明，并列入未验证项。真正的心跳要等实例侧有心跳上报再说。

### 5. 状态机做成一份数据，三处读同一张表

`ops.allowed_deployment_actions(status)` 是纯函数，返回五条边的可达动作：

| 状态 | 允许 |
| --- | --- |
| `planned` | `go_live` / `retire` |
| `active` | `start_maintenance` / `retire` |
| `maintenance` | `end_maintenance` / `retire` |
| `retired` | 无 |

详情响应的 `allowedActions`、非法迁移回包的 `allowedActions`、前端按钮三处读
同一份。三份副本里漏一条边，症状是「按钮点得动但一直 409」——而 409 的
`allowedActions` 又会告诉前端「你不该点这个」，两句话互相矛盾。

`retired` 是终态，没有出边：设备下线后重新上线是**另一台实例**（换机器、换
授权），把同一行改回 `active` 会让两段互不相关的历史接在一起。

### 6. 「已上线必须有上线日期」落在表上，不落在动作里

契约把「`go_live` 需 `go_live_on`」写成动作级校验（缺了回 400）。动作级能挡住
正常路径，挡不住「先建一条 `active` 再补日期」——而 `active` 但 `go_live_on`
为空的实例会让「上线时长」这类统计直接算不出来（减 NULL 得 NULL，聚合时静默
变成 0 条）。

所以表上加 `CHECK (status NOT IN ('active','maintenance') OR go_live_on IS NOT
NULL)`，动作级那条 400 保留（给可读的 `reason`），两层各管一段。PATCH 里也
提前判一次并回 `go_live_on_required`——表级 CHECK 抛的是数据库异常，那是
500 而不是业务错误。

### 7. PATCH 用 jsonb 补丁，「键在不在」就是全部语义

`{environmentRef: null}` 与「没传 `environmentRef`」在 SQL 里长得一样，含义
相反：前者清空、后者别动。

o-t10 的租户映射用了一对 `p_set_*` 布尔，因为只有两个字段。这一域有八个可编辑
字段，八对布尔是十六个参数。改成 `p_patch jsonb` + `p_patch ? 'key'` 判键：
参数表不随字段增长而膨胀，`null` 与「没传」天然分得开。

代价是 API 层必须**只把真的传了的键放进 patch**。把整个 body 原样丢下去
（包括 schema 默认补出来的 `undefined`），一次「只想改环境标识」的保存会把
负责人、维护到期日、合同全部清空——而且不报错。

路由里是显式枚举：八个键各写一行 `if (body.x !== undefined) patch.x = body.x`。
看着啰嗦，但比一个 `Object.entries` 循环安全：循环会把 `undefined` 也带上。

### 8. 空补丁不写：一次没改任何字段的「保存」不能推 version

`changed` 是空对象时直接返回当前状态，不 UPDATE、不写审计、`version` 不动。

理由是乐观锁：`version` 是两端比对的那一格。一次「打开抽屉又关掉」的保存把
version 推上一格，另一个标签页手里的数字立刻失效，重试一次又推一格——最后
两个人都在重试，谁也存不进去。X2 断言「同值 PATCH 不改 version、不写审计」。

### 9. 升级记录 append-only，触发器让表属主也改不了

契约 §3.7 只写「仅 INSERT」。和授权快照、租户尝试一样，只靠 `REVOKE` 挡得住
业务身份、挡不住表属主——而「这次升级其实失败了」被改成成功，等于把
`current_version` 的依据抹掉，整个域的可信度从这一行开始崩。

`BEFORE UPDATE OR DELETE` 触发器一律 `raise restrict_violation`（23001）。
R17 / R18 用属主身份直接 UPDATE / DELETE 各撞一次。变异：注掉触发器，
R17/R18 加两条级联红。

### 10. `license_id` 与 `private_licenses.deployment_instance_id` 是两个方向

前者是「开通时指定的主授权」，后者是「这份授权绑在哪台机器上」。详情里的
`licenses[]` 走后者（权威方向，o-t09 的部分唯一索引保证一台机器同时只有一份
有效授权），`license_id` 只做摘要展示。

两者可能不一致（先建实例、后建授权；或授权改绑到别的机器），**刻意不互相
回写**——回写会在两个地方各留一次真相，而「哪个是真的」这个问题没有答案。
这一条登记为 C-119：需要一个口径，但在拿到口径之前，不做自动同步比做错了好。

### 11. 两种 `version_mismatch` 落在不同的 409

PATCH 与 transition 的版本不符是 409 `CONFLICT`：乐观锁，换个版本号重试。
登记升级的版本不符是 409 `STATE_CONFLICT` + `details.reason = 'VERSION_MISMATCH'`：
用户该刷新看一眼当前版本，而不是换个数字再试——换数字意味着他在编造一个
自己没见过的 `from_version`。

契约 §5.8 的两行分别这么写，不是笔误。路由里两处错误映射分开写，单测各一条。

### 12. 授权与合同必须属于同一个客户

拿乙客户的授权给甲客户的机器上线，之后按客户算「已授权未部署」与「已部署
未授权」两张表都会算错——而这两张表正是运营端用来催续费的和催上线的。

`create_deployment_instance` 与 `update_deployment_instance` 都校验
`license_customer_mismatch` / `contract_customer_mismatch`，A9 / A10 与 X 组的
跨客户授权各一条。授权不存在是 `license_not_found`（不是 404——端点本身存在，
是引用断了）。

## 踩坑

### 1. 一张表落地，别处的「表不在就跳过」立刻变成「真查」

`ops.deployment_version_records` 一存在，工单域 `add_ticket_reference` 里那个
`to_regclass('ops.deployment_version')` 守卫就从跳过变成真查。

三处红：`ops_support_domain` 的 R1 / R2 / R4（它们随便编一个 `deployment_version`
的 uuid 就能挂上），加上集成 `ops-tickets.test.ts` 的「links a reference」。

这和 o-t10 那一轮是同一件事的第二次：**上一轮我用 `deployment_version` 当了
「仍是空域」的替身，这一轮它就落地了**。改法不是把 uuid 换成另一个还没落地的
类型（那只是把炸弹往后传），而是：

- pgTAP 先以属主身份插一条真实的升级记录，再以运营身份拿它当引用；
- 新增 R5 / R6 正向断言：编造的 `tenant_command` 与编造的 `deployment_version`
  都回 `reference_not_found`；R7 跨客户实例回 `reference_customer_mismatch`，
  R8 未知实例回 `reference_not_found`。

只把红的那几条改绿，等于把「守卫从未被验证」永久固定下来。

### 2. pgTAP 里的身份切换位置错了，断言会在错误的角色下通过

这一份测试有三个身份：交付运营（read+write）、商务运营（只有 read）、无角色。
P 组要证明「商务运营能登台账、不能推状态」，所以 P1 之后切到商务身份。

第一次写的时候，身份切换写在了 P1 之后——于是 P2 / P3 还在交付运营身份下跑，
`throws_ok` 期待 `42501` 却什么都没抛，两条红。修完切到商务身份之后，X 组
（PATCH）又整组跑在商务身份下，X1 / X2 拿到 `NULL` 而不是实例 id。

**身份切换的坑在于它不报错**：错的角色往往只是「权限更大」，于是断言照样绿，
只是绿的是一条没被验证的断言。所以每一组开头都显式写一行
`SET LOCAL ROLE authenticated` 或回到属主，宁可重复，不靠继承。

### 3. `information_schema` 与 `audit_events` 按角色权限过滤，白名单断言必须回属主

W 组（禁止凭据列白名单）与 U 组（审计）第一次跑全 0 / 全 NULL：这两组
要求「本域两张表里不得出现 `ssh_private_key` / `db_password` / `connection_string`
等七类列」，查的是 `information_schema.columns`——而它**按当前角色的权限过滤**。

`authenticated` 对这两张表是 `REVOKE ALL`，所以看见的是空集。空集让「没有
凭据列」与「什么都看不见」得到同一条绿。

`ops.audit_events` 同理。修法是 W 组前 `RESET ROLE`、U6 前再切回——**白名单类
断言最容易骗过自己的一处，因为它绿得毫无破绽**。

### 4. `#>>` 返回 `text`，函数重载按参数类型匹配

`#>> '{deployment,id}'` 的类型是 `text`，`create_deployment_version_record`
的第一个参数是 `uuid`。PostgreSQL 不会隐式转换，报的是

```
function ops.create_deployment_version_record(text, ...) does not exist
```

一个看起来像「函数没建」的错误，实际是「参数类型不匹配」。13 处一起补
`::uuid`。

同一类还有一处：`transition_deployment_instance` 的 `p_go_live_on` 在 T14 漏了
一个位置参数，报 `function ... (unknown, unknown, unknown, integer) does not
exist`——`unknown` 是字面量的类型，`integer` 是 `p_expected_version`，从签名
可以看出少的是哪个 date。

**这类错误的读法是看签名里剩下的类型，不是读函数名。**

### 5. 串行文件的计数断言会记住前面组的副作用

G2 / G3 断言「按状态筛出 2 条」「按类型筛出 2 条」，第一次写的是 1。

原因是文件是串行的：主实例在 T 组被退役过（`retired`），第二台实例在 R 组被
建成 `dedicated`。写断言时脑子里记的是「只有一台 planned」，但数据库里已经是
三台实例、两个状态。

计数类断言在长文件里必须先回头数**此刻**的行，不能数「我建过几行」。

### 6. 单测夹具的键名与真实 RPC 形状对不上，30 条里红 29 条

`ops_context_contract_violation`——API 层对 ops 会话上下文的形状做了 zod 校验，
夹具里的键名写成了 `email` / `display_name` / `status`，真实形状是
`operator_email` / `operator_display_name` / `operator_status`，还缺
`permission_version` / `last_login_at`。

抄隔壁 tenant 单测的夹具就能对——**同一个中间件，同一份形状，没有第二种**。
另有一条 `分页翻译成 RPC 参数` 的 400，原因是 `pageSize=5` 不在
`PAGE_SIZE_OPTIONS`（`[15, 10, 20, 30, 50, 100]`）里，改成 30。

## 未验证项

1. **并发登记没测。** 两条连接同时给同一台机器登记升级，`for update` 会串行化
   它们，第二条会拿到已经推进过的 `current_version` 而回 `version_mismatch`。
   推理成立，但没有跑过——pgTAP 与集成都是单连接串行。
2. **`license_id` 与 `licenses[]` 可能不一致。** 两个方向刻意不回写（决策 10）。
   实际后果：实例上写着授权 A，`licenses[]` 里没有 A（A 被改绑到别的机器），
   详情页会自相矛盾。已登记 C-119，需要一个口径。
3. **`rolled_back` 只能表达「回到原地」。** 守卫要求 `from_version` 等于当前
   版本，所以一条 `rolled_back` 记录读作「本来在 1.0.0，想升到 1.1.0，回滚了，
   还在 1.0.0」。真正的「从 1.1.0 回滚到 0.9.0」表达不了——那需要
   `from_version` 允许不等于当前版本，与 T-11 的拒绝断言直接冲突。
4. **退役之后仍可登记升级记录。** `update_deployment_instance` 与
   `transition_deployment_instance` 都挡了 `retired`，但
   `create_deployment_version_record` 没挡。一台已下线的机器还能登一条「升级
   成功」，并把 `current_version` 推进——按契约字面不算错（终态管的是状态，
   不是版本），但业务上很怪。等产品口径。
5. **升级记录没有保留策略。** 表上两张索引、一个实例每次升级一行、且
   append-only 到属主也删不掉。按每月若干次升级估算，三年后是「实例数 × 月数 ×
   次数」行，而 `get_deployment_instance` 每次把该实例**全部**记录带回。现在
   一条用例的数据量不超过十几行，所以慢这件事一次都没被观测到。
6. **`environment_ref` 只校验非空。** 它是客户内部的环境名（`bj-prod-01`），
   但没有任何东西阻止有人把连接串填进去——而本域明令禁止 `connection_string`
   列（W 组白名单）。白名单管住了列，管不住值。
7. **`current_version` 是 `text`，没有格式约束。** `1.5.0` 与 `v1.5.0` 是两条
   互不相干的历史，`from_version` 的等值比对会把它们当成不同版本；按版本排序、
   算「落后几个版本」也都做不了。契约没给格式，自己定会让前端先被实现绑死。

## 下一步

`o-t13` 总览报表。它是这一条线上第一次**跨域读**——客户数、在管实例数、维护
到期数、待办工单数、待续授权数从五张表里合出来，而 `o-t10` 与 `o-t11` 刚落地
才有完整的数字来源。契约 §8 的依赖图把 T-14 跨域回归放在它之后，一次跑
P1–P13。

一并要处理的返工：

- **C-114 回填**：权益域的 `suspend` / `resume` / `revoke` 与变更单 `execute`
  仍回 `command: null`。表在、端点可用，剩下的是改成真建命令 + 一条端到端断言。
- **`ops.write_audit` 的空白**：客户 / catalog / 合同 / billing 上半四个域仍
  一处都没调过（`o-audit-write`）——而这一域刚证明了审计是能写的。
