# C3 标签管理补全

日期：2026-11-15 · 卡片：C3（P1）· 出口：改名 / 删除（被引用 RESTRICT）/ 客户批量打标 + 界面

## 问题

标签这个功能此前只有「列出来」和「建一个」两个端点，而且**前端一个入口都没有**：
`createTag` 没有任何界面调用方，所以新建客户时那个标签下拉永远是空的。
「能建不能改名、能建不能删、建了也没有入口」—— 等于标签只有半条命。

核实后的三处硬缺口（都查过代码，不是推测）：

| 缺口 | 证据 |
| --- | --- |
| 没有 UPDATE 策略 | `20261029000001` 只建了 `customer_tags_select_reader` / `customer_tags_insert_writer` |
| 没有表级 DELETE | 该迁移只 `GRANT select, insert, update`（C2 踩过同一个坑） |
| 删标签会静默清关联 | `customer_tag_links_tag_fk ... ON DELETE CASCADE` |

第三条是最危险的：删一个标签不会报错，但所有客户的打标记录一起消失，事后无从追溯。

## 决策

1. **外键从 CASCADE 收紧成 RESTRICT**，接口层把 23503 映射成 `409 OBJECT_REFERENCED`。
   标签是客户的分类依据，被引用时应当删除失败并要求先解除引用；错误码不复用通用 `CONFLICT`
   （前端对两者的提示语不同：一个说「先解除引用」，一个说「重名了」）。
2. **改名走 `PATCH /api/customer-tags/:tagId`，空 PATCH 直接 400**。
   允许 `{}` 只会变成一次只改 `updated_at` 的空写，没有任何语义。
3. **批量打标整批成功或整批不变**，不做「部分成功」。
   批量接口先按可见性把客户 ID 回读一遍（`deleted_at=is.null` + RLS 的 own 过滤），
   有任何一个读不到就 `CustomerBatchScopeError` → 404，**一行都不写**。
   部分成功会让用户看到「有的打了有的没打」却不知道差在哪，重试还可能重复打标。
   这里还有一层安全含义：`customer_tag_links` 的写策略只看组织与 `customer.write`，
   **不看客户可见性**；不回读就能给别人的客户打标。
4. **同一个标签同时出现在 add 与 remove 里 → 契约层拒绝**，不猜优先级。
5. **建标签的入口一并补上**（管理器顶部一行：名称 + 色值 + 新建）。端点本来就有，
   没有入口等于这个功能不存在；管理器既然已经有了，「新建」是它的第一格。
6. **改色只做在新建里，不做逐行改色**：卡片要的是改名与删除，端点支持改色但不加界面。

## 改动清单

| 层 | 内容 |
| --- | --- |
| 数据库 | `20261115000005_customer_tag_manage.sql`：`GRANT DELETE` + UPDATE 策略 + DELETE 策略 + 外键 CASCADE→RESTRICT |
| 契约 | `updateCustomerTagRequestSchema` / `customerTagParamsSchema` / `customerTagDeletedResponseSchema` / `batchCustomerTagsRequestSchema` / `batchCustomerTagsResponseSchema` + 3 条路由 |
| 服务 | `updateTag`、`deleteTag`（返回 `deleted/not_found/in_use`）、`batchTag` |
| 路由 | `PATCH/DELETE /api/customer-tags/:tagId`、`POST /api/customers/batch-tags` |
| 前端 | `CustomerTagManagerModal.vue`（建/改名/删）、`CustomerBatchTagModal.vue`（加或减）、客户列表加勾选与「标签管理」「批量打标」 |
| 测试 | `customer_tag_manage.sql` 7 条断言；`routes.test.ts` 新增 10 条；`tests/integration/customer-tags.test.ts` 新增 5 条真实链路 |

## 验证

| 门禁 | 结果 |
| --- | --- |
| pgTAP | **34 文件全绿**（42 个迁移），新增 7 条断言 |
| 单元测试 | **60 文件 / 809 用例**（改前 799） |
| 类型检查（api + web） | 0 错误 |
| eslint + CSS token | 通过 |
| HTTP 集成 | **22 文件 / 385 用例**（新增 `customer-tags.test.ts` 5 条） |

**变异验证**：把新迁移里的 `ON DELETE RESTRICT` 改回 `CASCADE` 后重跑 pgTAP，
`customer_tag_manage.sql` 立刻变成「通过 4 / 失败 3」——
`a tag still linked to a customer cannot be deleted`、`... left the link untouched`、
`... deletable once nothing links to it` 三条同时变红。改回后全绿。

**为什么额外加了一条 HTTP 集成用例（原计划没写）:** 批量打标依赖
`Prefer: resolution=ignore-duplicates` + `on_conflict=customer_id,tag_id`，
这是 PostgREST 侧的行为，**pgTAP 与单测都证明不了**——写错只会在线上 400。
新用例在真实 PostgREST 上验了三件单测覆盖不到的事：
1. 删被引用标签真的以 23503 回来（→ 409 `OBJECT_REFERENCED`），且打标记录还在；
2. 同一批重复提交两次都 200（幂等），不是第二次 409；
3. 批里有读不到的客户时整批 404 且**一行都没写**。

**前端行为不在自动门禁内**（`vue-tsc` 只保证类型）。

## 未做

- **没有为这两个前端弹窗写 E2E**。A1 那张卡才是前端主线 E2E 的归属，这里不重复建设。
- **逐行改色界面**：端点支持（`color: null` 清除），界面只做了新建时填色。

## 顺手发现（不在本卡范围，未改）

`node scripts/format-sql.mjs --check` 在本机对 **66 个既有 SQL 文件**报不合格。
逐个比对后确认原因是**换行符**：仓库里是 CRLF（`core.autocrlf=true`），
而 sql-formatter 一律输出 LF，因此这条门禁在 Windows 上必然失败、在 Linux 上才通过。
不是格式真的走形，也不是本卡引入的。我误跑过一次 `--write`，它一口气改写了 68 个文件，
已全部 `git checkout --` 退回；本次提交的 SQL 只有两个新增文件（LF，符合格式化器输出）。
建议以后在本机只对新增 SQL 文件跑 `sql-formatter`，或给脚本加 `endOfFile`/换行归一化。
