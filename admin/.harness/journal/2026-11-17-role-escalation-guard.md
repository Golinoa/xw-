# 2026-11-17 自我提权防护：把「授予集合 ⊆ 我自己有的权限」做成表级守卫

## 1. 结论

审计点名的那条是真洞：`ops.create_role` 只校验「权限码存在」，不校验「我有没有」。
持有 `role.manage` + `operator.manage` 的人可以建一个全权角色，再把它分给自己。
`LAST_ADMIN` 那道自锁防的是「把自己降没」，防不了「把自己升上去」。

本轮补了 **一半**：建角色 / 改角色权限时，授予集合必须是调用者权限的子集。
另一半（分配已有全权角色给自己）**没补**，原因和办法见 §4。

| 项 | 本轮前 | 本轮后 |
| --- | --- | --- |
| 建一个「带我没有的权限」的角色 | 允许 | 42501 拒绝 |
| 给已有角色追加超出自己范围的权限 | 允许 | 42501 拒绝 |
| 把已有全权角色分给自己 | 允许 | **仍允许（未补）** |
| pgTAP 文件数 | 38 | **39** |

## 2. 做法与取舍

守卫挂在 `ops.role_permissions` 的 BEFORE INSERT 上，而不是改 `create_role` / `update_role`：

- 写这张表的路径有两条，将来还可能有第三条；表级守卫一次覆盖全部入口；
- 两个 RPC 各两百行，整段复制只为加十行校验，代价和走样风险都不划算。

两类豁免是刻意的：

1. **没有会话**（`auth.uid()` 为空）——迁移、种子、后台维护。那时不存在「调用者」，
   拦了等于把部署流程锁死。
2. **`current_setting('role')` 是 `none` / `postgres` / `supabase_admin`**——DBA 本来就能直接改表。

判 `role` 而不是 `current_user`：RPC 是 `SECURITY DEFINER`，函数体内 `current_user` 一律是属主，
分辨不出调用来源。这个选择是被测试逼出来的——第一版用 `session_user` 判定，
结果 psql 里跑的既有用例（`ops_identity_rls.sql:492`，`RESET ROLE` 后直接 insert）被误拦。

## 3. 验证

```
node scripts/db/local-db.mjs verify
→ 迁移重放：47 个文件
→ 全部通过：39 个测试文件
```

新文件 `ops_role_escalation_guard.sql` 四条断言：

1. 无 `SET ROLE` 的会话（种子路径）写入不受限；
2. 以受限管理员身份建「带 operator.read 的角色」→ 42501；
3. 建「只含自己已有权限的角色」→ ok；
4. 反复尝试之后权限集合没有扩大，仍是 `role.manage + operator.manage`。

## 4. 没补的那一半，以及为什么

「把**已有的**全权角色分配给自己」堵不住，因为在 `ops.update_operator` 里顺序是
**先删调用者现有角色、再插入新角色**——插入时调用者自己的权限已经是空集，
表级触发器拿不到「删除前」的基线。第一版我确实写了 `operator_roles` 的触发器，
它把正常的分角色也拦了（`ops_identity_rls.sql` 第 492 行的多角色并集用例当场变红），
所以撤掉，不留一个会误伤的表级守卫。

正解是在 `ops.update_operator` 内部做语义检查：比较
「after_permissions − before_permissions（新增部分）」是否 ⊆ 调用者权限，在 DELETE 之前判。
这需要 `CREATE OR REPLACE` 整个函数（约 150 行），单独一个改动做。

## 5. 下一步

1. `update_operator` 内的分配范围检查（另一半，见 §4）。
2. 访问审计：`packages/contracts/src/ops/audit-actions.ts` 没有登录/读取类动作码，
   `apps/api/src/modules/ops/auth/routes.ts` 全文 0 处 audit。
3. 工单链路不写 `ops.audit_events`，所以「审计失败」这类测试目前没有对象可测。
