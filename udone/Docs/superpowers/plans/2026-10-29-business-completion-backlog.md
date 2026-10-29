# 业务端未完成任务开发计划（udone）

> **For agentic workers:** 执行时配合 `superpowers/subagent-driven-development` 或 `superpowers/executing-plans`；步骤用 `- [ ]` 勾选跟踪，完成项必须附验证证据。

**Goal:** 把 `udone` 业务端从「能跑通演示」推进到「可交付试运行」：先关掉当前无法验证的盲区，再补数据完整性与权限口径，最后按需求缺口逐模块补齐。

**本文与真源的关系:** 本文件是**执行层任务清单**，不重定义任何需求。

| 问题 | 去哪看 |
|---|---|
| 产品范围与验收口径 | `Docs/REQUIREMENTS.md`（R-ID 唯一真源） |
| 路线图阶段划分 | `Docs/superpowers/plans/2026-10-03-mvp-and-launch.md` |
| 工程约束与门禁 | `.harness/ENGINEERING_STANDARDS.md`、`.harness/TESTING_STANDARDS.md` |
| 状态汇报格式 | `.harness/REPORTING.md` |

本文件只做一件事：把上述来源里**未完成**的部分，拆成可执行、可验证、可提交的任务，并标注每一项的现状证据与验收标准。

## 基线（2026-10-29 当次实测）

| 门禁 | 结果 |
|---|---|
| `format:check` | 通过 |
| `format:sql:check` | 25 个文件通过 |
| `lint` + CSS token | 通过 |
| `schema:check` | 与 13 个迁移一致 |
| `check:deploy` | 通过 |
| `typecheck` | 通过（**仅 `tsc --noEmit`，不含 `.vue`**，见 A2） |
| `test` | 37 个文件 / 255 用例通过 |
| `build` | 通过（主 chunk 1,638.00 kB / gzip 506.52 kB，见 D1） |
| `db:local:verify` | 重放 13 个迁移，11 个 pgTAP 文件 **189 断言**全过 |

规模：13 迁移 / 31 个契约端点 / 6 个 API 模块 / 5 个前端业务模块。

**E2E 现状**：`tests/e2e/` 2 个 spec、6 个用例，全部是登录与成员邀请（`auth.spec.ts`、`member-onboarding.spec.ts`），客户、订单、收付款主线**一条都没覆盖**；`.workflow/ci.yml` 里没有任何 Playwright 步骤。

**本机服务栈现状**：无 Docker、无 Supabase CLI、无 PostgREST 二进制。数据库验证靠原生 PostgreSQL 17 + `scripts/db/supabase-shim.sql` 兼容层完成，不经过 PostgREST，因此 API 到数据库的真实 HTTP 链路从未被自动验证过。

## 任务总览

共 **21 项**未完成项：A 段 5 项、B 段 2 项、C 段 12 项、D 段 2 项。下表 C6–C12 合并为一行呈现，明细见 §5。

| 编号 | 任务 | 优先级 | 规模 | 依赖 |
|---|---|---|---|---|
| A1 | 前端主线 E2E（Playwright + 网络拦截） | P0 | M | — |
| A2 | `.vue` 纳入类型检查（`vue-tsc`） | P0 | S/M | — |
| A3 | 服务端 HTTP 集成（PostgREST 假设） | P0 | L | 需决策 |
| A4 | vitest worker 超时定位 | P1 | S | — |
| A5 | 供应商模块行为测试 | P1 | S | — |
| B1 | 审批历史不随明细行删除消失 | P0 | M | — |
| B2 | 客户回收站与 `restore` 权限 | P1 | M | — |
| C1 | R-APPROVAL-01 审批流配置化 | P1 | L | — |
| C2 | R-MASTER-01 客户来源维护 | P1 | S/M | — |
| C3 | R-MASTER-01 标签管理补全 | P1 | S | — |
| C4 | R-ROUTE-01 线路主数据 | P1 | M | — |
| C5 | R-TOURIST-01 游客名单 | P1 | L | C4 |
| C6–C12 | 结算 / 余额 / 报表 / 通知 / 审计 / CRM / 公司配置 | P2 | L | 见 §5 |
| D1 | 前端产物体积（chunk 拆分） | P2 | S | — |
| D2 | E2E 接入 CI | P1 | S | A1 |

---

## 阶段 A：验证闭环

当前最大的风险不是「功能没做」，而是「做了但不知道对不对」。这一阶段把盲区变成证据。

### A1 前端主线 E2E（Playwright + 网络拦截）

- [ ] 新增 3 个 spec，覆盖「登录 → 订单列表 → 订单详情金额行 → 发起收款申请 → 审批通过 → 金额从在途转已收」

**现状证据:** `tests/e2e/` 仅 2 个 spec / 6 用例，全部围绕登录与成员邀请；上一轮提交说明里明确写了「这个界面没有在浏览器里跑过」。

**做法:**
- 用 Playwright 内置 `page.route('**/api/**')` 拦截请求，不起真实后端。
- **stub 的响应体必须先用 `@erp/contracts` 的 schema 解析一遍再返回**。stub 与契约不一致时当场失败，否则 E2E 会养活一份平行契约——那比没有 E2E 更危险。
- 同时覆盖四种状态：空列表、加载失败（500 时显示可读文案而非白屏）、无权限（按钮不出现）、驳回未填意见（提交前拦下）。

**验收标准:**
- 新增 ≥3 个 spec，`pnpm e2e` 本地全绿。
- 提交说明写明边界：**只证明前端渲染与交互，不证明服务端行为**。

**规模:** M

### A2 `.vue` 纳入类型检查

- [ ] 安装 `vue-tsc`，`@erp/web` 的 `typecheck` 改为 `vue-tsc --noEmit`

**现状证据:** `vue-tsc` 未安装；根 `typecheck` 是 `pnpm --filter @erp/web --filter @erp/api typecheck`，而 web 侧跑的是 `tsc --noEmit`，`.vue` 的 script 与 template 类型错误不进这道门禁。改一个 prop 名字，编译期不会报，运行时才知道。

**做法:** 装依赖并换脚本；首次运行暴露的真实错误逐个修，**不允许用 `// @ts-nocheck` 抹平**——抹平等于把门禁换成装饰。

**验收标准:** 门禁绿；journal 记录首次运行暴露的错误数量与类型（这是「盲区有多大」的唯一证据）。

**规模:** S/M（取决于首次运行错误量）

### A3 服务端 HTTP 集成（PostgREST 假设）

- [ ] 让至少 6 个写端点在真实 HTTP 下跑通，含乐观锁与三个 409

**现状证据:** 仓库层单测全部打桩；31 个端点的真实 HTTP 行为无自动覆盖。上一轮用一次性 SQL 探针（真实 PG，跑完 `ROLLBACK`）手工验了 9 个参数名与 `result_application_id` / `new_status` / `new_step` / `error_code` 四组返回列名——**这恰恰证明这层假设会错**，而错了只会在生产 500，探针不入库等于没有回归保护。

**决策点（需确认后执行）:**

| 方案 | 做法 | 代价 | 覆盖 |
|---|---|---|---|
| **a（推荐）** | 下载 PostgREST 单文件二进制，复用 `local-db.mjs` 的原生 PostgreSQL，用真实 HTTP 跑集成测试 | 引入一个外部二进制，需批准下载 | 参数名、返回列名、HTTP 状态码映射全部真实 |
| b | 仓储层改为可注入 `pg` 直连做集成测试 | 成本低 | 只剩 PostgREST 差异未覆盖，需记为已知风险 |

**验收标准:** ≥6 个写端点真实 HTTP 通过；`version` 冲突、`APPLICATION_STATE_CONFLICT`、`AMOUNT_EXCEEDS_AVAILABLE` 各有断言。

**规模:** L

### A4 vitest worker 超时定位

- [ ] 连续 5 次全绿，或给出根因与规避配置

**现状证据:** 已复现 3 次（34 文件 214 用例 + 1 error、34 文件 233 用例 + 2 error、一次首跑），每次复跑都干净；三次都发生在刚跑完数据库重放之后。怀疑 CPU 争用，**无证据**，config 未改。

**做法:** 复现时同时抓进程列表与 CPU；对比 `pool: 'forks'` 与 `'threads'`；若确认资源争用，固定配置并把结论写进 `.harness/TESTING_STANDARDS.md`。

**验收标准:** 连续 5 次稳定全绿，或根因 + 规避配置 + 书面记录。

**规模:** S

### A5 供应商模块行为测试

- [ ] 新增 `apps/api/src/modules/suppliers/routes.test.ts` 与服务层关键分支

**现状证据:** `packages/contracts/src/suppliers.ts`、`apps/api/src/modules/suppliers/{routes,service}.ts`、4 个前端文件都在，但**没有任何测试文件**（grep `supplier` 只在别的模块测试里被顺带引用）。这是唯一一个「完整交付但零行为断言」的业务模块。

**覆盖:** 租户隔离、重名冲突、被应付引用时不可删（`OBJECT_REFERENCED`）、列表筛选与分页。

**规模:** S

---

## 阶段 B：数据完整性与权限口径

### B1 审批历史不随明细行删除消失

- [ ] 有历史申请（含已驳回/已撤回）的明细行不可硬删，或删除后轨迹仍可读

**现状证据:** `finance_applications` 的三个外键都是 `ON DELETE CASCADE`（`20261029000008_finance_applications.sql:77–79`）。

已经挡住的部分：有在途申请的行删不掉——`update_order_with_items` 的删除判定含 `pending_amount > 0`（`20261029000006:192/202`），`order_line_update.sql:492` 有断言。

缺口：**被驳回或已撤回**的申请不占额度，行就能删，`finance_application_actions`（只追加的审批轨迹）随 CASCADE 一起消失。轨迹是审计材料，不该因为一次订单编辑而蒸发。

**做法（二选一，需决策）:**
- 外键改 `ON DELETE RESTRICT`：删行前必须先处置申请，界面需给明确文案与入口。
- 申请与轨迹改软删：删除不再抹历史，回收站语义与 B2 统一。

**代价提示:** 订单编辑现在允许整行删除，改 RESTRICT 会让「删行」在存在历史申请时返回 409，必须同时提供界面上的处置路径，否则用户会卡住。

**验收标准:** pgTAP 断言其一成立；API 映射错误码；前端给出可读提示。

**规模:** M

### B2 客户回收站与 `restore` 权限

- [ ] 新增 `customer.restore` / `order.restore` 权限 + 专用 SELECT 策略 + 恢复端点 + 回收站页

**现状证据:**
- `customers` 有 `deleted_at`，RLS 已隐藏，但**没有恢复入口**——软删等于单向。
- `20261029000004_soft_delete_visibility.sql:16–17` 的注释已经写明意图：「后续做回收站时不要放宽这两条策略，应另加一条带 `customer.restore` / `order.restore` 权限的 SELECT 策略，让恢复能力与读取已删除数据的能力绑定。」
- `packages/contracts/src/permissions.ts` 里**没有** `customer.restore` / `order.restore`。
- 订单状态机已有 `restore` 动作（`cancelled` → `previous_status`，`20261029000002:711`），但走的是 `order.write`，与上述注释的意图不一致。

**做法:** 两个新权限；独立的「读已删除」策略（恢复能力 = 读已删除能力）；恢复端点；回收站页（R-ORDER-03 的一部分）。订单 `restore` 改用 `order.restore` 并更新权限快照。

**验收标准:** pgTAP「无 restore 权限读不到已删除行」「有权限可读可恢复」；`permissions.test.ts` 快照按意图更新。

**规模:** M

---

## 阶段 C：需求未开始

### C1 R-APPROVAL-01 审批流配置化

- [ ] 配置表 + 实例快照 + 级次驱动流程，≥3 级可跑

**现状证据:** `current_step integer NOT NULL DEFAULT 1 CHECK (current_step BETWEEN 1 AND 2)` 与 `step ... BETWEEN 1 AND 2` 写死在迁移里；流程固定为「财务 → 管理员」两级；「允许撤回」「允许同人审批」是固定值，不是配置。

**关键约束（来自需求，不可省）:** 在途实例必须保存流程快照，**修改配置不得静默改变既有实例**。

**验收标准:** pgTAP「改配置不改变在途实例」；3 级流程可跑通；两个开关各有效。

**规模:** L

### C2 R-MASTER-01 客户来源维护

- [ ] CRUD 端点 + 客户表单下拉（含二级来源）

**现状证据:** `customer_sources` 只有建表、RLS、复合外键与两级唯一索引，**无任何 API、无下拉**。客户表单里 `source_id` 无法选择。

**规模:** S/M

### C3 R-MASTER-01 标签管理补全

- [ ] 补改名、删除（被引用时 RESTRICT）、客户批量打标

**现状证据:** 只有 `listCustomerTags` 与 `createCustomerTag` 两个端点，没有改名与删除。

**规模:** S

### C4 R-ROUTE-01 线路主数据

- [ ] 线路表 + 下拉 + 订单保存名称与金额快照

**现状证据:** `orders.route_name` 是纯文本，**没有线路主数据表**。改线路名后历史订单无法追溯原名称（R-FIN-01 要求「历史名称和金额不得随主数据修改而漂移」）。

**规模:** M

### C5 R-TOURIST-01 游客名单

- [ ] 名单 CRUD + 证件号去重 + CSV 预览/整批原子

**现状证据:** 全仓 `tourist` 零引用——表、API、页面都没有。

**覆盖要点:** 按证件类型 + 规范化证件号去重；证件号为空不自动合并；重复证件/非法日期/缺列/编码错误使**整批拒绝**，不产生部分写入。

**规模:** L

---

## 阶段 D：工程与性能

### D1 前端产物体积

- [ ] 主 chunk < 500 kB，或给出「为什么不能拆」的结论

**现状证据:** `dist/assets/index-BSn1wpC7.js` 1,638.00 kB / gzip 506.52 kB，构建报 `Some chunks are larger than 500 kB after minification`。

**做法:** `build.rollupOptions.output.manualChunks` 拆分 antd / vue 生态；顺手核对是否有全量引入（`ant-design-vue` 按需加载是否生效）。

**规模:** S

### D2 E2E 接入 CI

- [ ] `.workflow/ci.yml` 跑 A1 的 spec，以实际跑通为准

**现状证据:** CI 里没有任何 Playwright 步骤。

**注意:** 写完 yml 不算完成，必须看到流水线真实跑过并留下结果。

**规模:** S（依赖 A1）

---

## 5. P2 批量项（需求未开始，暂不拆细）

以下按 `Docs/REQUIREMENTS.md` 对应章节执行，开工时再拆成 A/B 阶段的粒度。

| 编号 | 需求 | 现状 | 规模 |
|---|---|---|---|
| C6 | R-SETTLE-01 批量结算 | 无表无 API | L |
| C7 | R-BALANCE-01 账户余额 | 无资金账户概念 | L |
| C8 | R-REPORT-01 报表与统一口径 | 无统计服务 | L |
| C9 | R-NOTIFY-01 站内通知 | 无 | M |
| C10 | R-AUDIT-01 审计日志 | 无独立审计表，仅有业务轨迹 | M |
| C11 | R-CRM-01/02 线索与公海 | 无 `leads` 表 | L |
| C12 | R-SETTING-01 公司配置 | 无 settings 表 | S |

---

## 6. 执行顺序与门禁规则

**建议顺序（先便宜的先做，先风险高的先做）:**

1. A2 —— 最便宜，先把 `.vue` 类型盲区关掉。
2. A1 —— 把前端从「未验证」变成「已验证」，这是当前最大的一块空白。
3. B1 —— 数据完整性，越晚做积累的历史数据越多，迁移越麻烦。
4. A5 + A4 —— 小成本补证据、去噪声。
5. B2 → C1 → C3 → C2 → C4 → C5 —— 业务功能按依赖推进。
6. A3 —— 需决策，可与上面并行。
7. D2 → D1。
8. C6–C12 按业务优先级排。

**每个任务的完成定义（缺一不可）:**

- 独立提交，提交信息说明「为什么」而不只是「改了什么」。
- 门禁全绿：`format:check` / `format:sql:check` / `lint`(+CSS token) / `schema:check` / `check:deploy` / `typecheck` / `test` / `build` / `db:local:verify`。
- 涉及迁移必须补 pgTAP；涉及行为规则必须做**变异验证**（改坏实现，确认断言真的变红）。
- 任务状态只有两种：**已验证** / **未验证**。不存在「基本完成」。
- 无法验证的部分（真实 Supabase、真实浏览器、真实流水线）必须在提交说明与 journal 中标注，不得被「全绿」掩盖。

## 7. 明确排除

- **admin 运营后台**：位于相邻仓库，由独立主线维护，不在本计划范围。
- **R-FILE-01 七牛文件存储**：需求已明确暂缓，触发条件是「出现需要持久化的上传/下载流程后另立执行任务」。在此之前不实现 SDK、上传 UI/API、签名 URL。
- **多实例限流与幂等**：当前为内存实现，已在代码注释与 `.harness/CONTRACTS.md` 标注「单实例有效」，等真正需要多实例时再做。

## 8. 跟踪方式

- 勾选本文 `- [ ]` 并附证据链接（提交哈希 / journal 文件）。
- 关闭任务时同步 `.harness/docs/exec-plans/tech-debt-tracker.md` 与 journal 当日记录。
- 本文与 `Docs/superpowers/plans/2026-10-03-mvp-and-launch.md` 冲突时，以那份计划的阶段划分与验收为准；本文件只在「任务粒度与现状证据」上更细。
