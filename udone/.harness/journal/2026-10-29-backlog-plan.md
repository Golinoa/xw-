# 未完成任务盘点与开发计划

## 今日完成

- `Docs/superpowers/plans/2026-10-29-business-completion-backlog.md`（新建）：业务端执行层任务清单，21 项未完成项（A 5 / B 2 / C 12 / D 2），每项带现状证据、做法、验收标准与规模。
- `.harness/PLANS.md`、`.harness/docs/exec-plans/active/README.md`、`.harness/docs/exec-plans/tech-debt-tracker.md`：各加一条指向新计划的索引。`PLANS.md` 此前只提平台基础与 MVP 两份计划，连 `p0-architecture-hardening` 都没索引，一并补上。

盘点没有沿用上一轮的口头结论，而是逐项回到代码核对。核对过程中推翻了自己的两个判断，也发现三处比原先描述更严重或更轻的地方。

## 基线（当次实测）

`format:check` / `format:sql:check`（25 文件）/ `lint`+CSS token / `schema:check`（13 迁移）/ `check:deploy` / `typecheck` / `test`（37 文件 255 用例）/ `build` / `db:local:verify`（11 个 pgTAP 文件 189 断言）全部通过。

主 chunk `index-BSn1wpC7.js` 1,638.00 kB / gzip 506.52 kB，构建仍报 >500 kB 告警。

## 关键发现

- **E2E 覆盖面比先前说的更窄**。`tests/e2e/` 是 2 个 spec、6 个用例，全部围绕登录与成员邀请；客户、订单、收付款主线一条都没覆盖，CI 也没有 Playwright 步骤。这比「三个 spec 从未跑过」更准确地说明了空白在哪。
- **`vue-tsc` 未安装**，web 侧 `typecheck` 跑的是 `tsc --noEmit`，`.vue` 的 script/template 类型错误根本不进这道门禁。这是上一轮「typecheck 全绿」里唯一没有被绿到的地方。
- **供应商模块零行为断言**。contracts、api module、4 个前端文件都在，但没有任何测试文件；grep `supplier` 只在别的模块测试里被顺带引用。
- **明细行删除的超卖路径不存在**。我原本准备把「在途申请所在的明细行可被删除导致额度释放」写进计划，核对后发现 `update_order_with_items` 的删除判定已含 `pending_amount > 0`（`20261029000006:192/202`），`order_line_update.sql:492` 也有断言。**这条划掉。**
- **但审批历史仍会丢**。`finance_applications` 三个外键都是 `ON DELETE CASCADE`（`20261029000008:77–79`）。被驳回或撤回的申请不占额度，行就能删，只追加的 `finance_application_actions` 跟着一起没。这是 B1，仍然是真缺口。
- **`restore` 的权限口径与注释不一致**。`20261029000004:16–17` 明确写了「后续做回收站时应另加带 `customer.restore` / `order.restore` 权限的 SELECT 策略」，但 `permissions.ts` 里两个权限都不存在，而订单状态机的 `restore` 动作走的是 `order.write`。意图写在注释里，实现没跟上。
- **数据库返回 `LINE_HAS_PAYMENTS`，契约是 `ORDER_LINE_HAS_PAYMENTS`**。一开始以为映射漏了，查完确认服务层内部用前者、路由层翻成后者，是对的。记录在此以免下次重复怀疑。
- **未开始的模块比预想多**：`customer_sources` 只有建表（无 API 无下拉）、`routes` 线路主数据表完全不存在（订单里 `route_name` 是纯文本）、`tourists` 全仓零引用、无 `leads`、无 settings、无资金账户。

## 决策与取舍

- **不把 admin 端写进本计划**。用户明确本轮只负责业务端，admin 由相邻仓主线维护。
- **A3 留成决策点而不是直接开工**。本地无 Docker / Supabase CLI / PostgREST，要覆盖「服务层对 PostgREST 的假设」只有两条路，其中推荐的那条需要下载外部二进制，属于要用户点头的事。
- **E2E 用网络拦截而非起真实后端**。因为起不来。这个选择必须付出代价：stub 响应体先用 `@erp/contracts` 的 schema 解析再返回，让 stub 与契约不一致时当场失败——否则 E2E 会养活一份平行契约，比没有 E2E 更糟。
- **计划只列到任务级，不写时间估算**。规模用 S/M/L 表达，因为工作量可判断而工期不可承诺。

## 遗留

- 21 项未完成项全部未开工，本轮只做盘点与计划。
- C6–C12（结算、余额、报表、通知、审计、CRM、公司配置）只给了表行，未拆细，开工时再拆。
- vitest worker 超时（3 次）仍未定位，已作为 A4 单列，不再挂在「偶发」名下糊过去。
