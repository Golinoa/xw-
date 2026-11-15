# B2 客户回收站与 restore 权限（第一步：数据库 + 契约）

日期：2026-11-15 · 卡片：P9-B2（P1）· 本步出口：pgTAP 12 条断言 + 契约类型检查

## 本步做了什么

1. **两个权限码**：`customer.restore`、`order.restore`，落 `organization_role_permissions`，
   与 `packages/contracts/src/permissions.ts` 保持一致。
2. **两条「读已删除」策略**：`customers_select_restorable`、`orders_select_restorable`。
   没有放宽原有策略（原策略里的 `deleted_at IS NULL` 原封不动）——
   Postgres 多条 permissive SELECT 策略是 OR 关系，所以效果是
   「有恢复权的人额外看见已删除行」，其他人照旧看不见。
3. **两个恢复函数**：`restore_customer(uuid)`、`restore_order(uuid)`，
   只清 `deleted_at`（恢复 ≠ 回滚编辑），返回命中的 id；没命中返回 `NULL` 而不抛错，
   与其它写函数「不存在 = 空结果，权限不足才抛」的口径一致。

## 决策

- **恢复权只给 admin**。理由：恢复是纠错动作，且「能读已删除数据」本身就是敏感能力；
  operator 的 own 范围语义是「我负责的客户」，不是「我删掉的客户」。
- **读已删除与能恢复绑在同一个权限上**，不拆成两个。拆开只会多出一条没人管控的读通道，
  而 `20261029000004` 的注释本来就写了这个意图。

## 连带改动（不是副作用，是必须）

`customer_rls.sql` 有两条断言按旧口径写死「admin 看不到已删除客户」。B2 之后
admin 有这个权限，两条断言必然变红。按新意图调整为：

- 「admin 读到本组织全部**在册**客户」→ 查询补 `deleted_at IS NULL`，数字不变。
- 「已删除客户不可见」→ 改为「对**没有** restore 权限的角色不可见」，期望值 0→1，
  文案同步改掉；无权限侧的证据放在新的 `restore_permissions.sql` 里。

这是「同一个事实两处断言」的典型代价：改语义必然要改旧断言，而不是把它删掉。

## 验证

- `db:local:verify` → **31 个测试文件全绿**（39 个迁移重放通过）。
  新增 `restore_permissions.sql` 12 条断言：无权限看不见 → 有权限看得见 →
  恢复后所有人看得见 → 重复恢复是无操作；客户与订单两侧各一遍。
- `tsc --noEmit`（apps/api，含 contracts 源码）→ 0 错误。
- `permissions.test.ts` 快照已按意图更新（PERMISSIONS 15 条、admin 15 条），
  用文本比对确认与常量一致；**该文件本身没跑**（本机缺 vitest）。

## 未做（第二步，卡环境）

- **恢复端点**（`POST /api/v1/customers/{id}/restore`、订单同名）与 `routes.ts` 条目；
- **回收站页面**（R-ORDER-03 的一部分）；
- 这两项都要改 `routes.ts` 与路由一致性守卫，而本机跑不了 vitest，
  改了就无法验证「契约与实现一一对应」。等依赖装好后一起做。

现状是：数据库已经具备「读已删除 + 恢复」的完整能力并有断言，缺的只是把它暴露成 HTTP。
