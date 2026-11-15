# C2 客户来源维护

日期：2026-11-15 · 卡片：P9-C2（P1）· 出口：pgTAP 6 条 + 单测 7 条 + 前端下拉可用

## 问题

`customer_sources` 有表、有 RLS、有复合外键与两级唯一索引，但**没有任何 API**；
客户表单里的「来源」是一个 `disabled` 的下拉，占位文案写着「来源维护功能尚未开放」。
结果就是 `customers.source_id` 这个字段永远为空 —— 有了列，用不上。

## 决策

1. **两级用「扁平 + parentId」返回，不做嵌套树**。前端按 parentId 分组即可；
   契约一旦嵌套，任何一层增删都要改递归 schema。
2. **不允许改 `parentId`**。改层级要额外校验「目标不是自己的后代」，否则会造出环；
   而层级是低频结构，删掉重建比在线改层级安全。
3. **删除交给外键**，策略只负责「能不能删」：
   - `customers.source_id` → `RESTRICT`：被客户引用就删不掉；
   - `customer_sources.parent_id` → `RESTRICT`：根下面还有子就删不掉。
   两种都返回 23503，接口层映射 409 并说清原因（409 而非 400：请求合法，是数据状态不允许）。
4. **下拉用「父 / 子」平铺**，不用 `a-select-opt-group`：选项组在搜索时会丢掉分组语义。

## 踩到的坑（值得记）

**只加 DELETE 策略不够，还必须补表级 GRANT。**

`20261029000001` 只给 `authenticated` 授了 `select / insert / update`，没有 `delete`。
我在 pgTAP 里先写了「无权限删除应返回 0 行」的断言，结果报的是
`permission denied for table customer_sources` —— **不是 0 行，是硬报错**。
表权限缺失时策略根本没机会生效，接口层会把它当 500。
所以 `20261115000004` 里是两件事：`GRANT DELETE` + `CREATE POLICY ... FOR DELETE`。

## 改动清单

| 层 | 内容 |
| --- | --- |
| 数据库 | `20261115000004_customer_source_delete.sql`：DELETE 授权 + 删除策略 |
| 契约 | `customerSourceSchema` / 列表 / 创建 / 更新 / 删除回执 + 4 条路由 |
| 服务 | `listSources`（默认只返回启用项，`includeInactive` 给管理页）、`createSource`、`updateSource`、`deleteSource` |
| 路由 | `GET/POST /api/customer-sources`、`PATCH/DELETE /api/customer-sources/:sourceId` |
| 前端 | 客户表单来源下拉从 `disabled` 改为可搜索可清空 |
| 测试 | `customer_source_delete.sql` 6 条断言；routes.test.ts 新增 7 条 |

## 验证

| 门禁 | 结果 |
| --- | --- |
| pgTAP | **33 文件全绿**（41 个迁移） |
| 单元测试 | **60 文件 / 796 用例** |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| HTTP 集成 | **21 文件 / 380 用例** |

## 未做

- **来源管理页**（改名/排序/启停的界面）。卡片写的是「CRUD 端点 + 下拉」，
  端点和下拉都通了；管理界面属于新页面，按范围控制没有顺手做。
- 停用的来源仍可选到「已停用但被历史客户引用」的记录：客户详情里 `sourceName` 照常显示，
  但下拉里不出现。要让历史值也出现在下拉里，需要在编辑时把当前值补进选项 —— 记在这里。
