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

## 第二步：客户恢复端点（2026-11-15 下午，依赖装好后）

`POST /api/customers/:customerId/restore` —— `CUSTOMER_RESTORE` 权限，返回 `{ restoredCustomerId }`。

三个实现决定：

1. **走 RPC 而不是像 softDelete 那样直接 PATCH**。已删除的行被 SELECT 策略隐藏，
   直接 PATCH `deleted_at=not.is.null` 连自己刚删的那一行都看不见；
   `restore_customer` 是 `SECURITY DEFINER`，权限判定在函数内部，绕开这个死结。
2. **不在回收站里一律 404**，不区分「没删过 / 不存在 / 别家组织」——
   区分等于告诉调用方某个 ID 是否存在，而这个 ID 他本来就读不到。
3. **订单恢复端点没做**。业务端根本没有删除订单的入口（`routes.ts` 里没有 `deleteOrder`），
   给一个「恢复一种到不了的状态」的端点只会成为死接口。等订单删除接入时一起做。

## 验证（全部门禁此时已可跑）

| 门禁 | 结果 |
| --- | --- |
| `db:local:verify`（pgTAP） | 31 文件全绿 |
| 单元测试 | **60 文件 / 789 用例** |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| HTTP 集成（PostgREST） | **21 文件 / 380 用例** |

客户模块新增 3 条单测：恢复成功、**有 customer.write 但没有 customer.restore 时 403**、
不在回收站时 404。中间那条是这张卡的要害——恢复不是写权限的延伸。

## 仍未做

- **回收站页面**（R-ORDER-03 的一部分）；
- **订单恢复端点**（理由见上）。
