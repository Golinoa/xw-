# 2026-11-17 租户命令执行机构：从「永远 pending」到「有人认领、有人回收」

## 1. 结论

T6 第 4 条此前判为未实现，理由是「台账齐了，执行侧为 0」：`record_tenant_command_attempt`
是唯一能推进终态的函数，但全仓生产代码零调用方，命令创建后停在 `pending` 永不结束。
本轮补上**数据层的执行机构**（认领 / 完成 / 回收），命令第一次有了「在谁手上、多久没回」的表达。

| 项 | 本轮前 | 本轮后 |
| --- | --- | --- |
| 能表达「派出去了但没回」 | 不能 | 能（`dispatching` + 租约） |
| 能区分「还没轮到」和「worker 死了」 | 不能 | 能（租约过期 → 回收） |
| 次数用尽后是否还在队列转圈 | 是 | 否（落 `failed/permanent`） |
| 结果由谁写 | 任何持有 service_role 的调用方 | 只有租约持有人 |
| pgTAP 文件数 | 37 | **38**（迁移重放 46 个文件） |

验证命令与结果：

```
node scripts/db/local-db.mjs verify
→ 迁移重放通过：46 个文件
→ 全部通过：38 个测试文件
```

## 2. 做了什么

- 新列 `claimed_at` / `claimed_by` / `lease_expires_at` / `max_attempts`（默认 8）
- 状态机加 `dispatching`，并加约束「在途必须有主」——没有持有人的在途行既回收不了也完不成
- `claim_tenant_commands`：只取到期、未超次数、未被持有，`for update skip locked`
- `complete_tenant_command`：校验 `status='dispatching'` + 持有人 + 租约未过期，再转调 `record_tenant_command_attempt`
- `reap_tenant_commands`：租约过期记一条 `timeout` 退回 `pending` 并排退避；次数用尽落 `failed/permanent`
- 三个函数都只授 `service_role`，并对 `public/anon/authenticated` 显式 `REVOKE`

## 3. 途中发现的两个既有缺陷

**（一）`record_tenant_command_attempt` 在 `mapping_id` 为空时崩溃。**
夹具一开始挂的是无映射命令，直接撞上
`record "mapping_entry" is not assigned yet`：函数把
`case when has_mapping then ops.tenant_mapping_json(mapping_entry.id) else null end`
写在 `jsonb_build_object` 里，PL/pgSQL 在 `mapping_entry` 从未赋值时连解析都过不去。
`mapping_id` 是可空的（设计要点 1），所以这条路径理论上可达。

本轮**没有修它**（修它要 `CREATE OR REPLACE` 整个 200 行函数，代价与风险不匹配），
而是在 `reap` 里加了跳过 + `skipped` 计数：回收是批处理，一条这样的行会让整批连带事务回滚，
跳过至少让它在返回值里可见，而不是让回收器整体停摆。**这条缺陷需要在 T6 收口前单独修。**

**（二）`retryable` 不含 `next_retry_at` 不是缺陷。**
审计报告曾把它列为口径 bug，实际源码注释写明是契约 §5.7 的刻意决定：
「只问现在还能不能重试，不问该不该」。改之前先读注释，避免把设计当 bug 修。

## 4. 第二段：派发层（同日晚补齐）

第一段交付后这套东西是「有锁没有开门的人」——能认领，没人定时去认领。当晚补上驱动侧（`1666a0b`）：

| 项 | 做法 |
| --- | --- |
| 编排 | `dispatchOnce` 纯函数：claim → deliver → complete，每条命令独立 `AbortController` |
| 超时 | 默认 15s，归 `transient`（值得再试）；其余异常归 `unknown`，两者错误码可区分 |
| 回写被拒 | 计 `skipped`，不算成功也不重试（租约被回收 / 持有人不符 / 无映射） |
| 幂等 | 下发带 `Idempotency-Key: <command_no>`，远端据此去重 |
| 触发 | `wrangler.toml` 的 `[triggers] crons = ["* * * * *"]`；**不进请求链** |
| 导出 | 用 `Object.assign(app, { scheduled })` 挂到同一对象，默认导出身份不变，既有单测零改动 |

验证：`vitest run` 66 文件 / 869 条全绿（新增 6 条）；`tsc --noEmit -p apps/api` 无输出。
另外 `generate-db-schema --write` 因新增迁移重生成 `.harness/docs/generated/db-schema.md`——
这一条是仓库既有门禁抓出来的（`harness-config.test.ts` 会比对清单是否过期）。

## 5. 明确没做（不要当成已交付）

- **租户侧接收端（M1）不存在**：派发会真的发 HTTP 出去，但对面还没端点接。
  在 M1 建好之前，`TENANT_API_BASE_URL` 指向任何地址都只会拿到 4xx/连接失败，
  命令会按分类落 `failed` —— 这是**预期**行为，不是 bug。
- `TENANT_API_BASE_URL` 未配置时按失败处理（不静默跳过），所以上线前必须配。
- 没有 staging 验证过「真的发出去了、对面真的收到了」。

## 6. 下一步（按顺序）

1. 修 §3(一) 的 `mapping_entry` 缺陷（一个迁移，替换函数体）。
2. 租户侧接收端（M1）：新 `INTERNAL_TOKEN`、机器对机器端点、按 `Idempotency-Key` 去重。
   这一步必须 staging，本地只能验逻辑不能验通讯。
3. 配 `TENANT_API_BASE_URL` 并观察一轮真实派发（journal 记下首轮的去重与失败分布）。
