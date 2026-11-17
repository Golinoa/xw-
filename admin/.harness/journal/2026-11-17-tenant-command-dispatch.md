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

## 4. 明确没做（不要当成已交付）

- **没有 worker / 定时器**。现在能认领，但没人定时去认领；`wrangler.toml` 无 `[triggers]`，
  `index.ts` 只有 `export default app`。所以这套东西目前是「有锁没有开门的人」。
- **没有下发实现**。`claim` 出来的命令没有消费方去调租户 API。
- 因此 `dispatching` 只会因租约过期被回收，不会真正完成。
- T6 第 4 条的「调用租户 API 只传业务字段」这半句仍未落地。

## 5. 下一步（按顺序）

1. 修 §3(一) 的 `mapping_entry` 缺陷（一个迁移，替换函数体）。
2. worker：`export default { fetch: app.fetch, scheduled }` + `[triggers] crons`，
   注意改默认导出会波及所有 `import app from '../src/index'` 的测试，需要一起改。
3. 租户侧接收端（M1）：新 `INTERNAL_TOKEN`、机器对机器端点、按 `Idempotency-Key` 去重。
   这一步必须 staging，本地只能验逻辑不能验通讯。
