# 运营身份域口径补齐（o-t03c，D-01 ~ D-05）

## 今日完成

- 新迁移 `supabase/migrations/20261030000006_ops_identity_alignment.sql`：
  - `ops.activate_invited_member()`：无参 `SECURITY DEFINER`，只把 `auth.uid()` 对应的
    `invited` 行转 `active`（`version + 1`、`updated_at = now()`），返回
    `activated / unchanged / missing`；不复活 `disabled`，不写审计（D-03 只有五个词）。
  - `ops.touch_last_login()`：无参 `SECURITY DEFINER`，只对 `active` 行写 `last_login_at`，
    返回 `ok / missing`；不自增 `version`（登录不是账号变更）。
  - `ops.invite_operator` / `ops.update_operator` 先 `DROP` 旧签名再重建，追加
    `p_display_name`（放在末尾，保持既有位置参数调用兼容），重新授权并补 `COMMENT`。
  - `displayName` 进 `operator.updated` 的前后摘要。
- 契约：新增 `packages/contracts/src/ops/audit-actions.ts`（5 个动作词 + 描述、
  `OPS_AUDIT_ACTION_CODES`、`opsAuditActionSchema`，刻意不用 `z.enum`）；`accounts.ts`
  的邀请/PATCH 请求加 `displayName`；`ops/index.ts` 加一行 re-export。
- Worker：`middleware/ops-auth.ts` 增 `activateInvitedMember` / `touchLastLogin`
  （形状违约 → 结构化日志 + 503）；登录路由在 `invited` 时激活、之后写 `last_login`，
  激活失败 503 且不发 cookie，`last_login` 失败只记日志；账号路由透传 `p_display_name`，
  邀请失败时补偿删除 GoTrue 账号（D-04）。
- 测试：新增 `supabase/tests/ops_identity_alignment.sql`（37 断言）；更新 auth/accounts
  单测（34 用例）；`tests/integration/ops-identity.test.ts` 加 invited 登录真实链路；
  本地夹具加一个 `status='invited'` 的运营账号。

## 关键决策

- `p_display_name` 追加在参数表末尾而不是插在 `p_reason` 后面：既有 pgTAP 用位置参数
  调 6 个/4 个参数，插在中间会让 `p_reason` 收到显示名。追加后旧调用全部仍成立。
- `update_operator` 的显示名语义：`NULL = 不改`、`''/空白 = 清空`。`NULL` 在这条 RPC 上
  已经是「不改」的哨兵，再让它表示「清空」就会两义相撞。
- `activate_invited_member` 返回 `unchanged` 而非 `activated` 时，登录按失败处理（503）：
  判定与激活之间行被并发改掉，此时发令牌下一次请求必然 403。
- `last_login_at` 不参与 `version`：否则管理员手里刚从列表拿到的乐观锁值会因为一次登录
  而失效，表现为一次假的 409。
- 集成测试另起一个 `ops-invited@integration.test` 夹具，而不是复用 `ops-invitee`：
  「有 invited 行」与「没有行」是两条登录分支，共用人就没法同时断言。

## 遇到的问题

- pgTAP 里用被激活账号读 `ops.operators` 拿到 NULL：RLS 对没有 `operator.read` 的账号
  返回零行。断言「函数返回什么」用 `authenticated`，断言「行变成什么」必须先
  `RESET ROLE` 回到属主身份。
- `ops_identity_write.sql` 的 `has_function_privilege` 写死了旧签名，函数重建后报
  「function does not exist」，改为新签名（6 参 / 8 参）。
- `schema:check` 因新增迁移变陈旧，已 `pnpm schema:generate` 重生成（并行会话的
  `000007` 落地后需要再跑一次）。

## 下一步计划

- 运营端（另仓）的审计筛选下拉改为从 `OPS_AUDIT_ACTIONS` 生成，补上 `operator.updated`
  / `role.created` / `role.updated` 三项。
- GoTrue 补偿删除只有单测与「补偿被调用」的证据；真实 `DELETE /auth/v1/admin/users/{id}`
  需要真实 Supabase 项目才能验收。
- 邀请表单可加「姓名」输入；账号列表可加显示名编辑。
