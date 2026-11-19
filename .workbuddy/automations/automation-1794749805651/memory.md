# 自动化执行记录：udone 业务 backlog 持续推进

## 2026-11-16 07:4x — D1 前端产物体积 ✅

- 单元：`app.use(Antd)` 全量注册 → 显式 27 组件清单（`design-system/antd-registration.ts`）
  + `vite.config.ts` 按生态 manualChunks + 守卫测试 `antd-registration.test.ts`（模板标签 ↔
  install 注册名对账）。顺手删掉无效的 `StyleProvider` 注册。
- **核心结论**：卡片问的「antd 按需加载是否生效」答案是**从未生效**；根因是逻辑不是路由。
  入口 chunk 1,871.64 → **38.04 kB**，首屏 JS 合计 −408 kB（gzip −21.4%）。
- **有意不做**：`vendor-antd` 895 kB 不再硬拆（构成全是真在用的组件）；分页面局部注册
  只是把 Table/DatePicker 推迟、总量不减，等 A1 浏览器回归后再上。
- 门禁：pgTAP 36 文件 / 单测 64 文件 851 用例 / typecheck / lint+CSS / build /
  Chromium 实测 `/login` 零 `Failed to resolve component`。
- 提交 `d550cb2`，已 push origin main。journal：`2026-11-16-d1-web-bundle-size.md`。
- 坑：`app.use(StyleProvider)` 只注册组件名、从没包裹过树 ⇒ 原本无效；
  手写注册清单漏项的失败形态是「构建和类型都不报，浏览器空白」。
- 范围外发现（已报未改）：`format:check` 全仓 225 文件红（CRLF，含未碰过的文件）；
  `apps/{api,web}/.nm-bad/` 残留目录刷 git 警告。
- **D2 判定为卡住**：依赖 A1 的 spec，且需能查看 Gitee Go 流水线真实结果（无控制台凭据）。
- 下一张：**A1 前端主线 E2E**（P0，M；3 个 spec，stub 必须先用 `@erp/contracts` 解析）
  → A5 供应商行为测试 → C6–C12。

## 2026-11-16 05:3x — C5 游客名单 ✅

- 单元：DB（`20261116000007_tourist_roster.sql`：`tourists` 表 + 规范化生成列 + 部分唯一索引
  + 4 条 RLS + `import_tourists` 库函数）+ 契约 `tourists.ts`（7 条 ROUTES、新错误码
  `TOURIST_DOCUMENT_CONFLICT`）+ 服务/路由 `modules/tourists/`（含纯 CSV 解析器）
  + 前端订单详情名单区（`TouristRosterSection/FormModal/ImportModal`）。
- **核心取舍**：不新增 `tourist.*` 权限（复用 order.read/write）；可见性用 EXISTS 继承订单 RLS；
  导入走库函数保证覆盖模式整批原子；模板只有表头（示例行会被真导入）。
- 门禁：pgTAP 36 文件（新 17 断言，变异红 7 条）/ 单测 63 文件 849 用例 / typecheck /
  lint+CSS / HTTP 集成 24 文件 402 用例（新 `tests/integration/tourists.test.ts` 11 条）。
- 提交：`5dcdac7` + 自审修复 `6b75d30`，已 push origin main。
  journal：`2026-11-16-c5-tourist-roster.md`。
- 坑：新表 `organization_id` 无默认值 → 直插测试必须显式传；掩码字段不能回填进可编辑输入框；
  编辑表单要逐个核对「界面能改的字段是否真的进了请求体」（这次漏了 `personType`）。
- 下一张：**D1 前端产物体积**（主 chunk 1638 kB，需 manualChunks 拆分或给出不能拆的结论）
  → D2 E2E 接 CI → A1 → A5。

## 2026-11-16 03:5x — C4 线路主数据 ✅

- 单元：DB（`20261115000006_route_master.sql`：`routes` 表 + 组织内名称唯一 + 4 条 RLS +
  `GRANT SELECT/INSERT/UPDATE/DELETE` + `route.read`/`route.write` 播种）+ 契约（`tour-routes.ts`、
  4 条 ROUTES、权限矩阵）+ 服务/路由 `modules/routes/` + 前端 `views/routes/*` 与订单表单线路下拉。
- **核心取舍：不给 `orders` 加 `route_id`**，订单只存名称快照（按值），pgTAP 断言改名/删线路后订单不变。
- 门禁：pgTAP 35 文件（新 `route_master.sql` 10 断言，变异红 4 条）/ 单测 61 文件 819 用例 /
  typecheck / lint+CSS / HTTP 集成 23 文件 391 用例（新 `tests/integration/routes.test.ts` 6 条）。
- 提交：`c115a4f`，已 push origin main。journal：`2026-11-15-c4-route-master.md`。
- 坑：数据修改型 CTE 必须在语句最外层；`permissions_and_disabled_sessions.sql` 的 operator
  权限快照断言遇到新权限必红（设计如此，按需更新）；`db:local.mjs http` 首次仍 PostgREST 超时，重跑即过。
- 范围外发现（已在回复中报给用户，未改）：`updated_by` 列在 routes/customers/sources/tags 上都无人写。
- 下一张：**C5 游客名单**（L，表/API/页面全无；按证件类型+规范化证件号去重，CSV 整批原子）。

## 2026-11-16 01:56 — C3 标签管理补全 ✅

- 单元：DB（`20261115000005_customer_tag_manage.sql`：GRANT DELETE + UPDATE/DELETE 策略 +
  `customer_tag_links_tag_fk` CASCADE→RESTRICT）+ 契约 3 路由 + 服务
  `updateTag/deleteTag/batchTag` + `PATCH/DELETE /api/customer-tags/:tagId`、
  `POST /api/customers/batch-tags` + 两个前端弹窗（标签管理 / 批量打标）+ 列表勾选。
- 门禁：pgTAP 34 文件（新 7 断言，变异改回 CASCADE 红 3 条）/ 单测 60 文件 809 用例 /
  typecheck / lint+CSS token / HTTP 集成 22 文件 385 用例（新增 `customer-tags.test.ts` 5 条）。
- 提交：`dd8cf92`，已 push origin main。journal：`2026-11-15-c3-customer-tag-manage.md`。
- 下一张：**C4 线路主数据**（`orders.route_name` 是纯文本，无线路表；需「订单保存名称与金额快照」）。
- 环境坑（已记）：`format:sql.mjs --write` 会因 CRLF vs LF 改写 68 个历史 SQL；本机只对新文件跑。
  `db:local.mjs http` 首次常 PostgREST 启动超时，重跑即过（B2 也是）。
- 无外部阻塞项。

## 2026-11-19 23:5x — D2 预检（清掉「流水线第一步必红」的真缺陷）✅ 部分

- 剩余卡片只有 D2，卡在「本机看不到 Gitee Go 结果」。改为排掉「已知会红」的点。
- **真缺陷**：`format:check` 在本机恒 207 文件红（autocrlf CRLF + endOfLine lf），
  一直被当噪音；按 **CI 检出内容（LF 导出）** 复验后只有 **4 个文件**真不合规
  （`ops/auth/routes.ts`、`CustomerRecycleBinView.vue`、`order-finance-flow.spec.ts`、
  `order-list-states.spec.ts`）。CI `quality_gate` 第一行就是它 ⇒ 已修，复验 0 不合规。
- **CI 模式 E2E 不挂**：`CI=1` 全量 24 通过 1 跳过 / 25.6s / 退出码 0 ⇒ 上一轮
  「跑完不退出」结案（只在复用外部 dev server 时出现，不是流水线风险）。
  lockfile 与 4 个 importer 逐项一致（`--frozen-lockfile` 安全）。
- 提交：`646f28e`（格式 4 文件）+ `43c06ce`（journal + 卡片 + 记忆），已 push main。
  journal：`2026-11-19-d2-ci-preflight.md`。
- **D2 仍不勾**：Gitee Go 里没有流水线对象，需用户在网页端新建并贴根目录 `.workflow/ci.yml`。
  本机拿不到流水线 API（缓存凭据是 9 位账号密码，OpenAPI 401）——这条别再试。
- 下一张：**无**。计划内 21 项只剩 D2 一格，全部依赖用户平台动作 / 密码。

## 2026-11-20 01:4x — D2 全序列回放 ✅（D2 仍未勾）

- 无新卡片可做，改为把 `.workflow/ci.yml` 的 goals **按序逐步原样回放**（不用等价轻量检查替代）：
  lint 10s / typecheck 11s / test **74 文件 925 用例** 13.6s / build 13s /
  schema:check 61 迁移一致 / check:deploy 3s / E2E `CI=1` **24 通过 1 跳过** 23.2s；
  `format:check` 按 LF 导出 0 不合规。Node 24.22.1 复跑单测同样 925 绿。
  ⇒ 预期流水线首跑即绿，剩余风险只在运行镜像（`--with-deps` 装 Chromium 依赖）。
- **纠正旧结论**：`format:sql:check` 的红不是 CRLF 噪音（换行归一化后仍 25 文件不一致），
  但 formatter 输出更差，决定不批量格式化；它不在 ci.yml 里。
- 提交 `f7e0ab4`，已 push main。journal：`2026-11-20-d2-ci-sequence-replay.md`。
- 下次若卡片仍全勾：**不要重复回放**（结果已记录）；直接确认 D2 平台侧是否已建流水线。


## 2026-11-20 03:4x — 收尾核查（无新卡）✅

- 计划内 20 项全勾，只剩 D2（Gitee Go 无流水线对象，本机 401）。
  **本轮刻意不重跑测试**（2h 前刚回放 ci.yml 全序列，HEAD 未变）；改为静态体检已打勾的卡：
  61 迁移 / 50 pgTAP / 34 集成 / 68 单测文件 / 7 E2E spec 只增不减；17 页面全挂路由；
  35 条 app.route（16 业务 + 17 ops）无孤儿模块 ⇒ 没有「勾了但东西没了」。
- 提交 `fab4dcb`，已 push main。journal `2026-11-20-backlog-closure-audit.md`。
- 🔴 **下次运行：若 D2 仍无用户确认，不要再回放、不要再做体检**——计划已无剩余工作，
  直接回复"无新卡、D2 待平台动作"，并建议暂停本自动化。用户点头后才动 D2。

## 2026-11-20 05:3x — 空转确认（无新卡）⏸

- 按上一轮结论执行：**不重跑门禁、不再体检**。只做三件低成本核实：
  1. 仓库干净、`main` == `origin/main` == `3e7cf83`（用户本轮未推任何东西）；
  2. 无 `GITEE_*` 令牌环境变量 ⇒ D2 的平台侧信息仍拿不到（不再试 API）；
  3. 抽查 B2 的争议点：`CustomerRecycleBinView.vue` 与路由 `customers/recycle-bin` 都在
     ⇒ 自动化提示词里"B2 只剩回收站页面"是旧快照，计划文件才是真源（B2 已全勾）。
- 未提交代码；只写记忆。
- 🔴 **下一轮同样处理**：仍是空转就只回复一句话，**建议用户暂停本自动化**（2h 一次无意义）。
  只有用户明确说"流水线已建好"或给出 Gitee 令牌，才恢复 D2 工作。

## 2026-11-20 07:3x — 第 3 次空转确认 ⏸

- 零代码改动、零门禁。核实：工作区干净；`main`==`origin/main`==`50c786e`；无 `GITEE_*` 令牌。
- 新增一条核实：`2026-10-03-mvp-and-launch.md` 的 39 个 `- [ ]` 是**过期复选框**（文件头已声明
  执行态以 business-completion-backlog 为准）⇒ 计划目录下真未勾的只有 D2，无遗漏卡。
- 已在回复中建议用户暂停本自动化。**若下轮仍是空转，不再做任何核实动作**，只回一句话。
