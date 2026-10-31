# 2026-10-31 · 租户映射与跨系统命令（o-t10）

## 这一单元做了什么

`o-t10` 是整条线唯一一域**一半的状态由自己写、另一半由外部写**的东西。

订单、合同、收款、权益——那些域里 `status` 列的每一次变化都发生在本仓库的
一个事务里。租户命令不是：运营端只能把它从 `pending` 推到 `retrying`、或者
推进 `cancelled`；`succeeded` / `failed` 必须由**远端的结果**驱动。`202 Accepted`
在这张表上不是一个礼貌的状态码，它是这个域的全部承诺边界。

两个提交：

- `a0a8b6a` 三张表 + 二十二个函数 + 69 条 pgTAP + 工单引用守卫收口
- `77c8a93` 契约包 + 十个端点 + 29 条单测 + 27 条集成

最终数字：30 迁移 / 23 个 pgTAP 文件 / 976 条断言（本域 69）；集成 15 文件
312 条；单测 53 文件 665 例；build 主 chunk 1,638.77 kB 无增长；deps:audit
critical 0 / high 0 / moderate 1 / low 0，白名单 0 条；许可 349 组通过。
13 道门禁全绿。

## 关键决策

### 1. 202 的真实性靠「谁能推进终态」，不靠状态码

一个假的 202 很好写：`INSERT ... status='pending'`，回 202，前端进去轮询，
永远等不到。所以这一域的验收要点不是「返回了 202」，而是**运营端有没有能力
把一条命令改成 `succeeded`**。

技术保证只有一条：`ops.record_tenant_command_attempt` 不授给 `authenticated`，
只给 `service_role`。

```sql
REVOKE ALL ON function ops.record_tenant_command_attempt (...)
  FROM public, anon, authenticated;
GRANT EXECUTE ON function ops.record_tenant_command_attempt (...) TO service_role;
```

那条 `REVOKE` 不能省。新建函数默认对 `PUBLIC` 有 `EXECUTE`，只写 `GRANT ... TO
service_role` 等于没拦——pgTAP 的 A1 就是拿这件事当断言的：去掉 `REVOKE`，它
从 `42501` 变成「没有异常」。

集成测试在 HTTP 层再证一次（运营令牌调 `rpc/record_tenant_command_attempt` 得
403），然后才换下发方令牌走完整条链路。**少了前一条，这个文件就变成「用超级
权限把业务跑一遍」，全绿不说明任何事。**

### 2. `sync_version` 只在远端确认时 +1，失败与超时都不动

如果混用（把「试了几次」也记进去），「重试三次才成功」在数据上会长得像「远端
被改了三次」。而 `sync_version` 是乐观锁的基线：运营端拿它当 `expectedSyncVersion`
提交下一条命令——多算一次，下一次提交就被自己挡住。

尝试次数在 `attempt_count` 里，两者职责不同。

失败的尝试连映射行都不碰（`record_tenant_command_attempt` 的 `failed` 分支没有
对 `tenant_mappings` 的 UPDATE）。「失败不动版本」在集成测试里断言的是**数值**：
失败后仍是 2，重试成功后是 3，而不是 4。

### 3. 超时不结束命令：`pending --timeout--> pending`

契约 §3.6 写的是「结果未知」，并要求「超时先查询远端状态再重试」。

把超时当失败处理会让「远端其实办成了」的请求被重发——而 `provision` 不是幂等的，
重发会在远端建出第二个租户（或者 409，然后运维手动去猜哪个是对的）。所以超时只：

- 加一条 `attempts`，`outcome = 'timeout'`；
- 推后 `next_retry_at`（`2^n` 分钟，封顶 60）；
- 状态留在 `pending`；若原来是 `retrying`，退回 `pending`——`retrying` 表达的是
  「正在办」，而结果未知等于「还没办成」。

### 4. `cancel` 只在「一次都没发出去过」时才允许

守卫是 `attempt_count = 0`。

发出去过就不能取消：远端可能已经受理，本地标 `cancelled` 等于假装它没发生，
而后续没有任何东西会让本地与远端重新对齐——这个域没有对账。已经发出的想收回
来，走 `revoke` 命令，那是一次新的下发。

变异验证：把 `if entry.attempt_count > 0` 改成 `> 99`，集成测试里「发出去过的
命令回 409 COMMAND_ATTEMPTED」一条红（返回体里 `status: "cancelled"`、
`attemptCount: 1`——取消一条已经试过一次的命令），复原复绿。

### 5. 终态不可逆，包括 `cancelled`

`record_tenant_command_attempt` 在 `succeeded` / `cancelled` 上直接返回
`{ status: 'command_terminated' }`，不写 attempt。

`cancelled` 也算终态，理由是**取消的前提会被事后拆掉**：取消意味着「一次都没发出去」，
此时补一条 attempt 会让那个前提当场失效，而取消已经据此成立过了。一次
「取消后又被记成成功」的命令，在台账上无法与被篡改的命令区分。

集成测试里这条断言原来是 `expect([200, 409]).toContain(response.status)`——什么
都没证明。改成确定性的 `command_terminated`。

### 6. 权限按 `command_type` 判，不按端点判

一个建命令端点承载八种命令、三类权限：

| 命令 | 权限 |
| --- | --- |
| `provision` / `bind` / `activate` | `tenant.provision` |
| `suspend` | `tenant.suspend` |
| `resume` | `tenant.restore` |
| `sync_entitlement` / `extend` / `revoke` | `entitlement.execute` |

端点级固定判一个权限时，两种错都不报错：判 `tenant.provision` 则 `suspend` 被
放行（该拦的没拦），判 `entitlement.execute` 则 `sync_entitlement` 被 403（该放的
没放）。与 o-t09 的 transition 同构。

`retry` 要两个动作码：`tenant.retry` **加上**原命令自己的动作码，分开判。只判
`tenant.retry` 的话，一个有重试权但没有 `entitlement.execute` 的人可以把一次
权益同步重试到底。

### 7. `udone_organization_id` 可空，与契约 §3.6 的 `NOT NULL` 有偏差（C-117）

三处契约放在一起读只有一个读法能同时成立：

- §3.6 表定义写 `udone_organization_id uuid NOT NULL`；
- §5.7 建映射的请求体把它标成**可选**；
- §5.7 PATCH 规定「非 `pending` 状态禁改组织 ID」。

若创建时必填，第二条就是废话、第三条永远走不到。而 `provision` 这条命令存在的
**理由**就是「租户还不存在」——先有映射、下发开通、远端返回 org id、回填。表格里
把它写成 `NOT NULL`，等于要求先知道答案再提问。

`UNIQUE(udone_organization_id)` 仍然成立：NULL 之间互不冲突，所以多条「还没绑定
的 pending 映射」可以并存——它们什么都还没指向。这正好是需要的语义。

### 8. PATCH 的两个布尔：`p_set_organization` / `p_set_external_ref`

`udoneOrganizationId` 没传与传 `null` 在 SQL 里长得一模一样，而这两件事含义相反：
前者「别动」，后者「清空」。只传一个值给函数，`externalRef` 就会在只想改组织 ID
时被静默清掉。

所以入站带 `p_set_*` 一对布尔，SQL 里逐个字段判。单测「只传 externalRef 时
set_organization 必须是 false」钉住这一条——翻译错了不会报错，只会丢数据。

### 9. 真正的下发没做（C-118）

本轮只有台账：命令怎么建、怎么重试、怎么取消、结果怎么记。没有 HTTP 客户端、
没有调度器、没有「超时后先查远端再重试」的那次查询。`record_tenant_command_attempt`
由谁调、什么时候调，属于下一个单元。

这一点必须在验收里说清楚：**能证明「状态机不许伪造成功」，不能证明「命令真的
发出去了」**。`202` 在这个域里的承诺只到「已受理」。

### 10. 三张表里唯一 append-only 的是 attempts

契约 §3.6 只写 attempts「仅 INSERT」。和快照一样，只靠 `REVOKE` 挡不住表属主——
而「这次下发其实失败了」被改成成功，是这一域唯一值得篡改的东西。加
`BEFORE UPDATE OR DELETE` 触发器 `raise restrict_violation`（23001）。

`tenant_commands` 与 `tenant_mappings` 都是可更新的（状态机要推进），所以它们的
保护只能靠状态机本身：`CHECK((status IN 终态) = (completed_at IS NOT NULL))` 让
「结束了但还是待办」这种行不可能存在——那种行会让「待办命令」这个列表永远清不掉。

`CHECK(status <> 'retrying' OR last_error_category IS DISTINCT FROM 'permanent')`
钉住「永久错误不许重试」，放在表上是为了让绕过端点的重试也拦得住。

## 踩坑

### 1. 直连 PostgREST 时看到的是 snake_case，写 camelCase 断言会「恰好」通过

集成测试里模拟下发方，为了绕开「运营令牌没有 EXECUTE」这层，直接

```ts
restRequest('rpc/record_tenant_command_attempt', { token: serviceToken, ... })
```

拿到的响应是 SQL 层的原始形状：`udone_organization_id`、`sync_version`、
`attempt_count`。camelCase 是 `protocol.ts` 出站时才做的转换，这条路径不经过它。

原来的断言写 `response.body.mapping?.udoneOrganizationId`——`mapping` 根本不是
`undefined`，只是键名不对，于是 `undefined?.x` 取到 `undefined`，
`expect(undefined).toBe('...')` 红了一片而看不出原因。报错是
`expected undefined to be '0000...'`，看起来像 RPC 没返回映射。

改法不是「把断言改成弱一点」，而是**给这条路径单独定一个 snake_case 的返回类型**，
让类型系统在下一次写错键名时直接报错。

### 2. 幂等键冲突有两层，线上先发生的是中间件那一层

`create_tenant_command` 里有 `idempotency_conflict`（同一把键换一件事），API 把它
翻译成 409 `CONFLICT` + `details.reason = 'IDEMPOTENCY_KEY_CONFLICT'`。

但集成测试里同一个请求拿到的是全局幂等中间件的 `IDEMPOTENCY_CONFLICT`——中间件
挡在路由之前，压根没到 handler。SQL 层那条路径只在中间件缓存过期、库里那条命令
还在时才露头，由 pgTAP 的 C 组覆盖。

断言改成中间件的错误码，并写清为什么：**测的是线上真正先发生的事**，不是「两条
路径中更好看的那条」。

### 3. 一张表落地，别处的「表不在就跳过」立刻变成「真查」

`ops.tenant_commands` 一存在，工单域 `add_ticket_reference` 里的
`to_regclass('ops.tenant_commands')` 守卫就从「跳过」变成「真查」。

三处红：pgTAP 的 R1/R2、集成 `ops-tickets.test.ts` 的「links a reference」。它们
原先随便编一个 `tenant_command` 的 uuid 都能挂上去。

改法是**换一个仍是空域的引用类型**（`deployment_version`，属 o-t11），再加一条
正向断言证明「校验真的打开了」：

- pgTAP 新增 R5：`add_ticket_reference(..., 'tenant_command', 编造的 uuid)` 返回
  `reference_not_found`；
- 集成新增「租户命令表落地之后，编造的 tenant_command 引用真的会被挡」。

只把红的那几条改绿是不够的——那就等于把「守卫从未被验证」这件事永久固定下来。

### 4. 单测里用不到的常量，是漏掉的透传验证

`routes.test.ts` 里 `CONTRACT_ID` 定义了三周没人用，lint 报 unused。

它的存在本身说明有一件事没被测：`sync_entitlement` 带着 `contractId` 与
`changeRequestId` 时，这两个外键有没有真的进 RPC 参数。丢了它们命令照样建成、
照样 202，但事后没人能回答「谁批的」——所以补了一条断言 `p_contract_id` /
`p_change_request_id` 透传的用例，而不是把常量删掉。

### 5. 前端要的 camelCase 与数据库的 snake_case，只能在边界转换一次

`protocol.ts` 的 `failure()` 助手最初写成：

```ts
const failure = (status: string, extra?: Record<string, unknown>) =>
  z.object({ status: z.literal(status), ...extra });
```

`z.literal(status)` 里的 `status` 类型是 `string`，整个信封联合退化成
`z.literal(string)`，于是 `command.attempts` 之类的字段在类型上不存在——typecheck
11 处红。改成泛型 `<S extends string, T extends z.ZodRawShape>` 之后每个分支保留
自己的字面量类型。

### 6. `DEFAULT_PAGE_SIZE` 是 15，不是 20

两条列表单测期望 `p_limit = 20`，全部红。20 是 SQL 函数里 `coalesce(p_limit, 20)`
的兜底值，不是 HTTP 层的默认页大小。两处数字不同不是 bug（一个兜 SQL 直接调用、
一个定 HTTP 语义），但测试里必须写对。

### 7. 集成测试的跨用例状态：`sync_version` 是串行的

这一份集成测试是一个叙事：建映射 → 开通 → 激活 → 失败 → 重试 → 超时 → 取消。
每条命令都带 `expectedSyncVersion`，而它是上一条命令的结果决定的。

所以任何一条中间用例红了，后面会级联成一片 `SYNC_VERSION_MISMATCH`——报错说
「currentSyncVersion: 2」，看起来很像是守卫写错了。这时候要先看**第一条**红。

## 未验证项

1. **真正的下发一次都没跑过**（C-118）。没有 HTTP 客户端、没有调度器。能证明的
   是状态机不许伪造成功，不是「命令真的发出去了」。
2. **`suspend` / `resume` / `revoke` 与权益域的接线没做。** o-t09 那三个端点仍回
   `command: null`（C-114）。表已经在了，剩下的是把端点改成真建命令，但那是 o-t09
   的返工，没有排进本轮。
3. **并发建命令没测。** `UNIQUE(idempotency_key)` 在并发下只会成一条，但 pgTAP 与
   集成都是串行的——两个连接同时 POST 同一把键没跑过。
4. **`next_retry_at` 只是记了个时间，没有人读它。** 退避是 `2^n` 分钟封顶 60，
   但没有调度器，所以「到点了该重发」这件事在本轮不存在。
5. **`request_id` 的贯通只做了半程。** `record_tenant_command_attempt` 收
   `p_request_id` 并存下来，但从运营端点建命令时并不会把当前请求的 request id
   写进去——下发方与建单方不是同一个请求，中间的关联没人维护。
6. **`mapping_id` 可空。** `tenant_commands.mapping_id` 是 `REFERENCES ... ON DELETE
   RESTRICT` 但没有 `NOT NULL`，理由是有些命令（如 `extend`）可能只挂合同条目。
   契约没写死，实现选了宽松的一侧；目前所有端点都从映射下建命令，所以这一格
   从未被走到。

## 下一步

`o-t11` 私有化部署台账。它与本单元有硬依赖方向：台账要引用部署实例，而实例是
`provision` 命令的下发目标——顺序不能反。`o-t13` 总览报表要等 `o-t10` 与 `o-t11`
都落地才有完整的数字来源；`o-t14` 跨域拒绝矩阵也依赖这两域的表。

一并要处理的两件返工：

- **C-114 回填**：把权益域的 `suspend` / `resume` / `revoke` 与变更单 `execute`
  改成真建租户命令，`command` 从 `null` 换成真实对象，并补一条端到端集成断言。
- **`ops.write_audit` 的空白**：客户 / catalog / 合同 / billing 上半四个域仍一处
  都没调过（`o-audit-write`）。
