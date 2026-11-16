# A5 供应商模块行为测试（含删除能力补齐）

日期：2026-11-16 · 卡片：P11-A5（P2）· 出口：12 条单测 + 6 条 pgTAP

## 问题

供应商是唯一一个「完整交付但零行为断言」的业务模块：
`packages/contracts/src/suppliers.ts`、`modules/suppliers/{routes,service}.ts`、
4 个前端文件都在，grep 不到任何测试。

而且它当时**只有 list + create 两条路由**。卡片要求的覆盖里有
「被应付引用时不可删（`OBJECT_REFERENCED`）」—— 这条路径根本不存在，
写一条断言它的测试只会得到一句空话。

## 决策：先补删除能力，再测

卡片的覆盖清单里有删除，所以我补了删除；但只补「薄」的那一层：

- **不自己数引用**，直接交给外键。`order_payables.supplier_id` 本来就是
  `ON DELETE RESTRICT`，自己数一遍只会产生第二套口径，两套迟早不一致。
- 23503 → **409 `OBJECT_REFERENCED`**，不是 `CONFLICT`。两者给人的下一步完全不同：
  重名改个名字就行，被引用得先去处置应付行。
- 顺带把关键词清洗抽成 `sanitizeSupplierKeyword` 并导出，让「服务层关键分支」可测。

## 又踩了一次同一个坑（这次是主动避开的）

`suppliers` 和 `customer_sources` 一样：`authenticated` 只授了
`select / insert / update`，**没有 `delete`**。所以迁移里两件事一起做：

```sql
GRANT DELETE ON public.suppliers TO authenticated;
CREATE POLICY suppliers_delete_writer ... FOR DELETE ...
```

只加策略不授表权限，报的是 `permission denied for table suppliers`（硬报错，不是 0 行）。

## 改动

| 层 | 内容 |
| --- | --- |
| 数据库 | `20261116000001_supplier_delete.sql`：DELETE 授权 + 策略 |
| 契约 | `supplierDeletedResponseSchema` + `deleteSupplier` 路由 |
| 服务 | `delete()` 返回 `deleted / not_found / in_use`；抽出 `sanitizeSupplierKeyword` |
| 路由 | `DELETE /api/suppliers/:supplierId`（`supplier.write`） |
| 测试 | `routes.test.ts` 12 条（新建文件）；`supplier_delete.sql` 6 条断言 |

## 测试覆盖（12 条）

- 列表：组织取自登录态（不接受 `?organizationId=`）、分页回显、关键词/结算方式/`activeOnly` 透传；
  `activeOnly` 缺省为「只看启用」。
- 新建：201；重名 → 409 `CONFLICT`；财务（只有 `supplier.read`）→ 403 且不落库。
- 删除：200 回执；被引用 → 409 `OBJECT_REFERENCED`；不存在 → 404。
- 关键词清洗：PostgREST 操作符变空格；**裸 `%` 被清成空**（否则 `ilike.*%*` 会命中整张表，
  等于把「搜索」变成「导出全部供应商」）；空白折叠与去首尾。

## 验证

| 门禁 | 结果 |
| --- | --- |
| pgTAP | **37 文件全绿**（45 个迁移） |
| 单元测试 | **65 文件 / 863 用例** |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| HTTP 集成 | **24 文件 / 402 用例** |

## 顺手修掉的两处挡路问题

1. `tests/e2e/support/api-stub.ts` 有 `OrderPayable` / `OrderReceivable` 两个未使用的类型导入，
   导致 `pnpm lint` 红 —— 这是 E2E 那批改动留下的（尚未提交），我删掉这两个导入让门禁能跑。
2. 我自己的 `response.json()` 返回 `unknown`，补了显式类型。

## 未做

- 供应商的**编辑与停用**仍没有：卡片只要求「列表/新建/删除 + 引用保护」，
  停用是个开关，属于主数据任务。
- 前端没有删除入口：本轮只做后端与契约，界面上的删除按钮留给前端任务。
