# 2026-11-17 工单审计：从「一条都没有」到「建单与变更都留痕」

## 1. 结论

`ops.tickets` 全表 **0 处** `write_audit` 调用。这不只是「查不到历史」——
审计那一批用例（「记审计失败会怎样」）连被测对象都没有，所以一直没写。

| 项 | 本轮前 | 本轮后 |
| --- | --- | --- |
| 建单留痕 | 无 | `ticket.created` |
| 改状态/指派/流转留痕 | 无 | `ticket.updated`（带 before/after 摘要） |
| 值没变的 UPDATE | — | 不记账（避免噪声） |
| 契约词表 | 无 ticket 词 | 补 `ticket.created` / `ticket.updated` |
| pgTAP 文件数 | 39 | **40** |

## 2. 做法

`ops.tickets` 上挂 `AFTER INSERT OR UPDATE` 触发器，统一写审计。
不逐处改 RPC 的原因：写工单的入口有 `create_ticket` / `update_ticket` / `assign_ticket` 三个，
将来还有流转，表级守卫一次覆盖，也不会因为新增 RPC 忘了写审计而漏记。

两个刻意的决定：

1. **摘要不含正文**。只带 `status / priority / assigneeOperatorId / waitingOn /
   resolutionSummary`。`subject` / `description` 是客户原文，进审计表等于又存一份，
   而且审计表的保留期通常比业务表长。
2. **`before = after` 直接跳过**。仓库里有「先删后插」的写法（`update_operator`），
   会产生值完全相同的 UPDATE；逐条记账会把审计表灌成噪声。审计里每一条都该是
   「发生了一件事」，不是「跑了一次 SQL」。

`write_audit` 对动作词不做白名单校验，所以词表在契约侧单独补——
否则运营端筛选下拉里出现的是「不在词表里的词」，这个坑仓库里已经踩过一次
（`operator.updated` / `role.created` / `role.updated` 曾经就是这样）。

## 3. 验证

```
node scripts/db/local-db.mjs verify
→ 迁移重放：48 个文件
→ 全部通过：40 个测试文件
```

新文件 `ops_ticket_audit.sql` 五条断言：建单记账、改状态记账、
before 留住 `new`、after 留住 `assigned`、空更新不产生噪声。

契约改动后 `vitest run` 66 文件 869 条仍全绿。

## 4. 边界

- 只覆盖 `ops.tickets` 主表。`ticket_events`（工单内的追加事件）与
  `ticket_references`（关联引用）没有单独记账——它们是**明细**，
  正文已在主表审计的 `ticket.updated` 里体现；如果后续要求「每条追加留言都要留痕」，
  再给 `ticket_events` 单独加，别塞进主表触发器的摘要里。
- 审计里的 `actor` 依赖会话（`auth.uid()` / `current_operator_id()`）。
  迁移、种子、后台维护写入的工单 actor 为空，这是设计上的「无主记录」，
  不是漏记。

## 5. 下一步

1. `update_operator` 内的分配范围检查（提权防护的另一半，见
   `2026-11-17-role-escalation-guard.md` §4）。
2. 访问审计：`apps/api/src/modules/ops/auth/routes.ts` 全文 0 处 audit，登录/登出没有记录。
3. 部署域审计无 `requestId`：路由 0 处 `p_request_id`，审计查不到「这一次请求」。
