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

新文件 `ops_role_escalation_guard.sql` 六条断言：

1. 无 `SET ROLE` 的会话（种子路径）写入不受限；
2. 以受限管理员身份建「带 operator.read 的角色」→ 42501；
3. 建「只含自己已有权限的角色」→ ok；
4. 把 `platform_admin` 分给自己 → `permission_out_of_scope`；
5. 分配范围之内的角色 → ok；
6. 反复尝试之后权限集合没有扩大，仍是 `role.manage + operator.manage`。

## 4. 被补上的那一半（当晚补完）

原本写在这里的是「分配已有全权角色这一半没补」。**当晚补完了**（`91b0669`），
做法是在 `ops.update_operator` 写库之前比较
「`after_permissions − before_permissions` ⊆ 调用者权限」，越界返回
`permission_out_of_scope`（与该函数其它失败分支同形状）。

为什么只能在 RPC 内部判：该函数是**先删调用者现有角色、再插入新角色**，
插入那一刻调用者自己的权限已被删空，表级触发器拿不到删除前的基线。
第一版确实写了 `operator_roles` 的触发器，它把正常的分角色也拦了
（`ops_identity_rls.sql` 第 492 行的多角色并集用例当场变红），所以撤掉——
宁可不留一个会误伤的表级守卫。

### 这里踩的坑（值得记）

`ops.update_operator` 在仓库里有**两份**历史定义：`20261030000005` 的 7 参数版，
和 `20261030000006` 里 `DROP` 后重建的 8 参数版（多 `p_display_name`）。
第一版我抄了旧的那份，`CREATE OR REPLACE` 于是造出第二个 overload，后果是：

- 调用方按 6 个位置参数调用直接报 `function ops.update_operator(...) is not unique`；
- 新 overload 默认对 `PUBLIC` 有 `EXECUTE`，`ops_cross_domain_denials` 的 A2 当场变红。

**教训：`CREATE OR REPLACE` 一个历史函数前，先 `grep "FUNCTION ops.<name>"` 数一遍定义，
以最后一份为准。** 参数列表差一个默认参数，就不会替换而是新增。


正解是在 `ops.update_operator` 内部做语义检查：比较
「after_permissions − before_permissions（新增部分）」是否 ⊆ 调用者权限，在 DELETE 之前判。
这需要 `CREATE OR REPLACE` 整个函数（约 150 行），单独一个改动做。

## 5. 下一步

1. `update_operator` 内的分配范围检查（另一半，见 §4）。
2. 访问审计：`packages/contracts/src/ops/audit-actions.ts` 没有登录/读取类动作码，
   `apps/api/src/modules/ops/auth/routes.ts` 全文 0 处 audit。
3. 工单链路不写 `ops.audit_events`，所以「审计失败」这类测试目前没有对象可测。
