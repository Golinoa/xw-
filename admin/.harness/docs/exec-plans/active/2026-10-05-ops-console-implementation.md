# 有单软件运营后台实施计划

> **执行要求：**按任务逐项执行，每项以复选框跟踪；开始实现前阅读本计划及其产品、架构和工程真源。后台前端属于 `~admin`；Hono API、运营 schema、RLS、数据库测试和租户命令属于 `../udone`。不得在两个工程间复制私有实现或重复维护 schema/API 真源。

**目标：**交付供软件提供方内部使用的运营后台 P0 功能，覆盖商业客户、产品合同、账款、授权、租户交付、私有化台账、售后、账号权限、审计和运营总览，并通过隔离、安全、流程、性能及受控发布验收。

**架构：**`~admin` 导入完整 Vue Vben Admin v5 workspace，只构建并独立发布 `apps/web-antd`；前端通过版本化运营 API 调用 `udone` 中的 Hono Worker。运营业务数据使用独立运营 schema 与 RLS，迁移、事务、鉴权和 API 仅在 `udone` 维护；两系统以已审阅的 API 契约集成，不共享源码 workspace。

**技术栈：**Vben `web-antd`、Vue 3、TypeScript、Vite、Ant Design Vue、pnpm workspace、Vitest、Playwright；后端复用 Hono、Cloudflare Workers、Supabase Auth/PostgreSQL/RLS。版本以实际导入并锁定的 Vben commit 配置为准。

**需求真源：**[PRD](../../../../Docs/PRD.md)、[技术选型](../../../../Docs/TECH_SELECTION.md)、[架构](../../../../ARCHITECTURE.md)、[运营后台工程规范](../../../../.harness/ENGINEERING_STANDARDS.md)、[API 规范](../../../../.harness/API_STANDARDS.md)、[数据库规范](../../../../.harness/DATABASE_STANDARDS.md)、[测试规范](../../../../.harness/TESTING_STANDARDS.md)、[安全规范](../../../../.harness/SECURITY.md)、[可靠性规范](../../../../.harness/RELIABILITY.md)。

## 全局约束

- 内部运营人员使用；不提供旅行社客户自助门户，不重做 `udone` 的旅行社业务。
- `~admin` 与 `udone` 是并列工程；前端单独构建发布，API/数据库仍由 `udone` 单一维护。运营前端不直接访问受保护表、不导入后端私有文件。
- 导入完整 Vben workspace，保留上游 MIT 许可与版权声明；锁定上游 commit、Node/pnpm 版本、依赖与 lockfile；不得只复制 `apps/web-antd` 单目录。
- 所有环境明确区分 local/staging/production。前端只使用公开配置和用户访问令牌；service role、签名密钥、对象存储凭证只存于 Worker secrets。
- 所有受保护操作由服务端验证身份、有效运营成员、具体权限及目标对象；UI 隐藏不能代替授权。RLS 对运营数据提供第二层隔离。
- 合同、收款、核销、退款、权益、租户命令和导出等高风险写入要求服务端授权、审计、事务/幂等保护与明确结果；超时先查询命令结果，再安全重试。
- 运营商业状态与 `udone` 运行状态分开记录；跨系统仅通过版本化、幂等、可查询状态的 API 命令同步。
- 产品/套餐变更不得改变历史合同和有效权益快照；账款和权益使用不可覆盖的流水/版本，更正走新记录或冲正。
- 测试只使用虚构数据；不得将真实客户、个人、合同、支付凭证、token 或密钥写入 fixture、日志、报告及 journal。
- 每项前端功能必须覆盖适用的 loading、empty、error、validation、permission-denied、conflict 和 destructive-confirm 状态；交互遵循根 DESIGN.md 与已定稿视觉规则。
- 新依赖必须说明用途、归属、维护状态、许可证、包体/运行时影响及安全公告；不得用未审查的模板 mock 作为业务能力。
- 工程约束必须有具体命令、失败阻断条件和可复核结果。没有自动化配置及成功/失败证据，不得称为自动门禁。
- 不将本计划的复选框预先勾选；只有实际执行、检查结果和验收证据齐全后才更新状态。
- Task 3–9 的每个新开发批次，编码前必须通过“目标源码参考门”：阅读下方映射的 ERPNext 源码及其测试，在执行 journal 记录精确文件/行为、可借鉴点、不采纳点、本项目实现落点和验证断言。已有进行中的批次不追溯重开；后续新增/修复范围照此执行。
- ERPNext (`D:/Coding/ERP/ERPNext`, `version-16`, `7474d9e786277383de1242ab882f16856d17a9c9`) 仅作只读设计样例。不得复制代码、元数据或引入其依赖；ERPNext 使用 GPL-3.0，复用代码须先单独许可审查。本项目的 PRD、实际目标系统证据、Cloudflare Workers/Supabase 架构及租户隔离约束优先。

## 评审重点

1. **越权身份：**匿名用户、普通 `udone` 租户用户、已停用运营用户或仅修改客户端 metadata 的用户访问运营 API 均拒绝；对应后端集成与 RLS 测试不得只用 mock。
2. **跨域访问：**运营角色不得读取旅行社订单、游客、应收应付等业务明细；普通租户身份不得读写运营 schema。正向与反向拒绝均需用真实 Postgres/RLS 证明。
3. **财务并发与重放：**重复收款/核销/退款和并发超额核销不能产生重复流水或越过余额；使用并发和幂等集成测试。
4. **合同/权益时间一致性：**目录价格/权益更新不改历史快照；未批准合同不能开通；有效权益调整、到期、停用、恢复均记录操作者/原因和历史。
5. **跨系统不确定结果：**租户开通/停用调用超时不得虚报成功或盲目重试；必须可查询命令状态、按幂等键重放并审计人工重试。

## 仓库职责与接口边界

- `~admin/`：Vben workspace、运营前端页面、路由/菜单呈现、浏览器 API client、前端构建、前端 CI 与独立静态部署。
- `udone/apps/api/`：运营身份、API 路由、权限、领域服务、跨系统命令、审计和错误映射。
- `udone/supabase/migrations/`、`udone/supabase/tests/`：运营 schema、grants、RLS、约束、事务/RPC 与 pgTAP；具体表名和策略由迁移决定，禁止前端计划臆造物理 schema。
- `udone/Docs/` 或 API 源码中的运营 API 契约为 API 的唯一真源；`~admin` 仅消费稳定、版本化的公开契约。每个业务域开始前，先核对该契约是否真实存在；缺失时先在 `udone` 实现/记录契约，再生成或更新 `~admin` 客户端。
- 运营前端的 API 层将认证、序列化、错误映射和请求关联封装在单一 adapter；业务模块不直接使用 Supabase SDK 访问受保护运营数据。
- Vben 示例页面/mock 数据只作为脚手架；移除或隔离默认演示路由和 mock adapter，不能混入真实业务入口。

## 任务依赖顺序

`Task 1 Vben 导入 → Task 2 自动质量门 → Task 3 运营身份/应用壳/API 契约 → Task 4 客户与产品合同 → Task 5 账款 → Task 6 授权与租户交付 → Task 7 私有化部署与售后 → Task 8 配置、审计、总览/报表 → Task 9 集成、安全、性能和发布验收`。

Task 1/2 可先建立前端骨架与静态门禁；从 Task 3 开始的业务端到端流程依赖 `udone` 对应 API、迁移/RLS 与数据库测试。后端 migration 由一个 `udone` 责任批次串行维护；不可因前端可先开发而绕过契约或创建运营影子数据模型。

## ERPNext 源码参考门与任务映射

开发者在新批次编码前完成以下步骤：

1. 对照下表阅读源码和测试；前端任务也要读行为源与测试，不能只看截图/README。
2. 将结论写入负责端的当日日志，给出源文件、关注的函数/规则、目标项目采用/不采纳决定、`~admin` 或 `udone` 中的实现位置及相应测试。
3. 把采用的做法变成本任务可执行的验收断言；无法映射的项目明确写“不适用”及理由。记录完成后再进入编码。

| 任务 | ERPNext 只读参考 | 适合评估的工程做法 |
| --- | --- | --- |
| Task 3 身份/权限/API | `erpnext/hooks.py`、`erpnext/selling/doctype/customer/{customer.py,customer.json,test_customer.py}` 中权限元数据和测试用法 | 权限声明集中管理、操作按动作授权、UI/服务端权限一致；ERPNext 的角色模型不直接等同运营权限模型。 |
| Task 4 客户/产品/合同 | `erpnext/selling/doctype/customer/{customer.py,customer.json,test_customer.py}`、`erpnext/selling/doctype/sales_order/{sales_order.py,sales_order.json,test_sales_order.py}` | 字段与状态约束、关联关系、历史快照、列表筛选和针对拒绝路径的测试。 |
| Task 5 账款/收款/核销/退款 | `erpnext/accounts/doctype/payment_entry/{payment_entry.py,payment_entry.json,test_payment_entry.py}`、`erpnext/accounts/doctype/gl_entry/{gl_entry.py,gl_entry.json,test_gl_entry.py}`、`erpnext/accounts/doctype/sales_invoice/{sales_invoice.py,sales_invoice.json,test_sales_invoice.py}` | 已确认交易保留、撤销走可追溯反向记录、重复/非法操作测试；本项目仍使用自己的精确金额与事务/RPC规则。 |
| Task 6 授权/租户交付 | 上述 `payment_entry` 生命周期校验与测试；`erpnext/hooks.py` 的事件注册 | 检查命令状态、失败/重试和审计边界是否可借鉴；ERPNext 没有与本项目租户交付完全对应的实现时，不强行类比。 |
| Task 7 私有部署/售后 | `erpnext/crm/doctype/lead/{lead.py,lead.json,test_lead.py}`、`erpnext/crm/doctype/opportunity/{opportunity.py,opportunity.json,test_opportunity.py}` | 状态时间线、责任人、列表过滤和变更测试；不引入本项目未定义的 CRM 流程。 |
| Task 8 账号/审计/总览/报表 | `erpnext/crm/doctype/opportunity/` 中报表/看板配套代码与测试；相关 DocType JSON 权限字段 | 汇总口径与明细一致、权限过滤先于汇总、导出权限和测试；只有符合 PRD 的部分才采用。 |
| Task 9 集成验收 | `ERPNext/erpnext/patches.txt`、本表涉及的业务测试 | 评估升级/迁移排序与回归覆盖组织方式；不把参考仓库的流程或结果当作本项目验收证据。 |

## 每批质量工程门

- **开发前：**检查工作树并保留已有 WIP；确认需求/R-ID、责任边界和 API/schema/RLS 真源；通过源码参考门；先写失败用例与边界条件，再开始实现。跨端业务仍由 `udone` 先冻结可审阅契约，随后 `~admin` 消费该契约。
- **开发中：**沿用 Task 1/2 已锁定的依赖、格式、lint、类型、测试和构建工具；新增依赖记录用途、许可、安全状态、包归属及锁文件影响。状态/财务/审批等操作使用明确命令、服务端授权、幂等/审计和可恢复历史；mock 只用于隔离 UI，不冒充集成。
- **每批交付：**执行对应端的自动质量门。前端补组件/浏览器测试；后端改数据库必须在隔离 PostgreSQL 验迁移、RLS/pgTAP；业务 API 测允许与拒绝路径；跨端功能做真实契约集成。保留命令、版本、结果、失败证据和未验证环境。
- **安全/依赖门：**凭证不进代码/fixture/日志；新增工程规则必须有自动入口、负向用例及阻断结果。涉及权限、租户、财务、导出时验证匿名/越权/跨域拒绝和授权路径，不以隐藏按钮作为安全证据。
- **完成门：**复核 diff 和任务边界，更新 R-ID 追踪、计划和 journal；只用实际环境证据关闭 staging、性能、恢复或发布验收。任何一项缺失则保持未完成并写清阻断原因。

## Task 1：导入并锁定 Vben `web-antd` 工作区

**责任目录：**`~admin/`。

**主要产物：**上游完整 workspace、仅启用的 `apps/web-antd`、锁定的上游 commit 与包管理器、保留的 MIT 许可文件、可重复的本地开发/构建命令。

- [x] 核实当前空文档目录及未提交文件；记录导入前状态，保留现有 PRD、架构、设计和 harness 文档。
- [x] 按 [TECH_SELECTION.md](../../../../Docs/TECH_SELECTION.md) 检查官方 Vben 源码、`web-antd` workspace 依赖、根 scripts、Node/pnpm 范围、MIT 许可和所选 commit；把 commit SHA 和核验日期写入技术选型/导入 journal。
- [x] 导入 Vben 共享 workspace 和唯一 `apps/web-antd` 应用到 `~admin`，不覆盖 `Docs/`、`AGENTS.md`、`DESIGN.md`、`.harness/`；保留上游许可证和版权声明，并审查上游忽略文件、脚本及安装生命周期命令。上游 `docs/` 因 Windows 大小写冲突不导入，原因见 TECH_SELECTION.md。
- [x] 锁定 Node 与 pnpm 的精确版本，保留单一上游 lockfile；仅安装 antd 应用、其依赖和明确需要的根工具，不复制其它产品应用。
- [x] 运行冻结锁文件安装、typecheck、lint、unit test、build；记录确切命令、工具版本和基线结果。全仓 lint 的文档格式问题及应用范围 lint 结果见本 Task 1 journal。
- [x] 清点 demo/mock 登录、路由、API、用户/菜单和静态内容，形成保留/后续替换清单；生产 API base 不再指向上游 mock 服务。
- [x] 更新 [TECH_SELECTION.md](../../../../Docs/TECH_SELECTION.md) 的实际 commit、工具版本与导入状态；完成 journal 并独立检查差异。

**Task 1 验证记录：**Node `24.20.0`、Corepack pnpm `10.33.4`。冻结安装成功；`apps/web-antd` typecheck、build 和源文件范围的 Oxfmt/Oxlint/ESLint/Stylelint 均通过；上游 unit suite 35 个文件、309 tests 通过。根 `pnpm lint` 执行时发现 10 个文档格式问题（其中 7 个未由 Task 1 修改）；Task 1 未批量格式化既有文档。详细命令、安装输出、警告和限制记于 `.harness/journal/2026-10-05-ops-console-frontend-foundation.md`。

## Task 2：建立可执行前端工程门禁

**责任目录：**`~admin/`。不得在此任务改造 `udone` 后端质量工具链。

**主要产物：**固定版本与 lockfile、格式/lint/typecheck/test/build/dependency/license/secret 门禁、PR CI 和前端预览部署边界。

- [x] 审核导入模板现有 formatter、linter、测试、依赖扫描、secret scan、CI 和部署 workflows；列出已经存在与缺失项，优先复用上游已配置工具。
- [x] 为项目声明的 Node/pnpm 加入一致的本地与 CI 版本约束，验证不兼容版本会在安装或 CI 开始阶段失败。
- [x] 配置根级可复现命令：冻结锁文件安装、format check、lint、typecheck、unit/component tests、`web-antd` build、lockfile dependency audit、许可证策略校验和 secret scan；依赖只放在实际使用包中。
- [x] 确定并固定漏洞/许可证扫描工具与策略：高危安全公告阻断；许可证 allow/deny 与人工例外有审阅记录；更新策略不绕过 lockfile 审核。
- [x] 增加无生产凭证的 PR CI，覆盖上述所有本地门禁；通过环境变量白名单检查与虚构 secret canary 证明服务端密钥会使 CI 失败。
- [x] 配置分支保护所需检查列表并记录需在代码托管平台单独启用/验证的设置；不把 workflow 文件存在等同于分支保护已启用。
- [x] 将 staging/production 发布与 PR CI 分开：PR 只构建/预览，不执行外部数据库写入，不读取生产 secrets。记录前端产物和 source map 中不存在 service role/私有凭证的验证命令。
- [x] 确认故意失败的 lint/typecheck/secret/dependency 策略用例能够阻断对应门禁；记录成功/失败日志和本地复现命令。
- [x] 将仍未自动化的规则列为明确 gap，不设未经批准的覆盖率比例；更新 `.harness/ENGINEERING_STANDARDS.md`、`.harness/TESTING_STANDARDS.md` 与 journal。
- [ ] 处理完整锁文件审计发现的 high/critical advisories，并复跑 `pnpm run quality:check` 取得绿色结果。2026-10-05 重启修复后仍有 2 条 high（`node-forge`、`braces`，官方公告均无可用修复版本）；不得忽略公告或缩小扫描范围以绕过门禁。
- [ ] 在托管平台运行真实 PR workflow 并单独启用/验证 `Frontend Quality / frontend-quality` 分支保护 required check；本地无 Git remote，尚无托管 CI run。

**Task 2 当前验证记录（2026-10-05 advisory 复核）：**官方全 lockfile audit 现有 4 moderate、2 high、0 critical。复核确认 `braces@3.0.3` 的 [GHSA-vfj7-8cjw-p6xm / CVE-2026-93687](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 仍标记 affected `<=3.0.3`、patched versions `None`；`node-forge@1.4.0` 的较新 [GHSA-86w9-cpqp-85rv / CVE-2026-85393](https://github.com/advisories/GHSA-86w9-cpqp-85rv) 影响 through 1.4.0、patched version 未知，npm latest 仍为 1.4.0。再次运行 `corepack pnpm run quality:check`：格式、lint、typecheck、Vitest 35 files/309 tests、构建、许可证、secret scan、bundle secret 检查和全部负向 canary 均通过；最终完整 lockfile audit 因上述 2 条 high 以 exit 1 结束。没有忽略公告或缩窄扫描。托管 PR workflow 与 `Frontend Quality / frontend-quality` 分支保护因本 checkout 无 Git remote 保持未验证。具体锁定路径和输出见 [Task 2 journal](../../../journal/2026-10-05-ops-console-quality-gates.md)。Task 2 保持未完成；Task 3 尚未开始。

**2026-10-05 Task 2 路径评估与门禁复跑：**冻结安装通过；完整 `quality:check` 的格式、lint、typecheck、Vitest 35 files/309 tests、构建、许可证、secret/bundle 检查和负向 canary 均通过，最终官方全锁文件 audit 仍为 4 moderate、2 high、0 critical 并以 exit 1 结束。复核 `node-forge` 路径为 `internal__vite-config > nitropack > listhen > node-forge`；这是 Vite 开发 mock 工具链依赖，不进入浏览器构建。`braces` 来自 `micromatch`，除 Changesets 发布工具外还由多个 lint/build 工具路径使用。npm dist-tag 仍只有受影响的 `node-forge@1.4.0` 与 `braces@3.0.3`；官方 advisory 对两者均无 patched version。删掉 Nitro mock/Changesets 或替换多条共享工具依赖会超出最小依赖路径修复并改变现有工具能力；本次不采用未发布补丁或降低扫描规则，安全修复项继续未完成。无 Git remote，真实托管 PR workflow 与 required check 仍无法验证；Task 2 保持未完成，Task 3 未开始。命令及风险评估见 Task 2 journal。

## Task 3：运营身份、应用壳与 API 契约接入

**责任：**前端在 `~admin`；运营身份 API/数据库在 `../udone`。

**接口产物：**稳定运营会话响应、角色/权限目录、前端 API client adapter、导航/路由权限消费契约，以及拒绝访问的统一 UI 状态。实际字段以 `udone` API 源码/契约为准。

- [ ] 在 `udone` 检查并设计运营成员关系、角色权限、会话验证与审计需求；将准确的 API schema、错误码和权限动作写入后端唯一契约源，验证身份逻辑与旅行社成员角色独立。
- [ ] 在 `udone` 实现运营 API 与 schema/RLS 的最小身份垂直切片：无授权 Auth 用户、普通租户成员、已停用运营成员均拒绝；管理员/内部员工授权以服务端可信成员关系判定，不采信可编辑 metadata。
- [ ] 为身份/API/RLS 写 Vitest 集成和 pgTAP 用例；运行本地数据库测试，证明允许与拒绝路径。身份邀请/停用、角色分配的高风险变更需审计。
- [ ] 在 `~admin` 建立 API adapter、运行环境配置校验、认证生命周期与 request ID 处理；通过公开契约生成/使用 client，保证数据访问不越过 Worker。
- [ ] 将 Vben demo 登录替换为真实认证流程；处理登录成功/失败、过期会话、登出、无运营权限、账号停用和网络失败，不提供公开注册。
- [ ] 建立角色/权限驱动的 route/menu/action 呈现；菜单隐藏只改善体验，API 仍须拒绝直接请求。
- [ ] 建立全局运营导航壳、用户状态和通用拒绝页；页面结构服从已定稿 DESIGN.md 与组件规范。
- [ ] Playwright 验证登录允许/拒绝、受保护路由重定向、无权限菜单/直接 URL、登出清理；后端 API/pgTAP 另外验证授权，浏览器 mock 不作为 RLS 证据。
- [ ] 联调真实 staging Auth/API 后记录脱敏请求证据；更新 API client、权限规范、部署 CORS allowlist 和 journal。

## Task 4：客户、产品目录、套餐与合同

**责任：**客户关系、产品/套餐、合同 API/数据/RLS 在 `udone`；对应页面及 client 在 `~admin`。

**依赖：**Task 3 完成；`udone` 发布本任务所需版本化 API 契约。产品条目与有效合同快照在领域模型中分开。

- [ ] 从 PRD §§6.2–6.4、§7.1–7.2、§8 拆客户/联系人、产品、套餐、价格版本、功能权益定义、合同、合同项与续约关联字段；未知字段不得根据 `udone` ERP 表猜造。
- [ ] 为重复客户标识、合同编号唯一性、目录改价不改变旧合同、已生效合同更正留版本记录编写失败测试和验收 fixture。
- [ ] 在 `udone` 以迁移/RLS/事务实现客户、产品目录与合同领域，明确外键、状态转换、审计事件、查询分页筛选和敏感字段授权；pgTAP 证明授权与租户/运营域边界。
- [ ] 发布客户、联系人、产品/套餐、合同列表/详情/草拟/生效/续约等准确 API schema 与错误响应；合同生效动作不得由通用 PATCH 绕过。
- [ ] 在 `~admin` 实现客户列表/详情与联系人、产品/套餐维护、价格版本和权益查看、合同列表/详情/草拟/提交/生效记录等模块；生效等高风险动作展示影响摘要和二次确认。
- [ ] 覆盖服务端分页/筛选、空/加载/错误/无权限/冲突状态；产品/套餐版本变更后浏览旧合同证明历史快照不变。
- [ ] Vitest/组件测试验证表单与 DTO；Playwright 覆盖客户创建到合同草拟、重复合同编号拒绝、历史价格/权益快照、权限拒绝；staging 记录前后端与数据库证据。
- [ ] 更新 `PRD.md` R-ID 到实现/验收链接；完成阶段 journal。

## Task 5：应收计划、线下收款、核销与退款

**责任：**财务 API/数据库在 `udone`；账款与收款操作 UI 在 `~admin`。

**依赖：**Task 4 的客户与有效合同 API；合同应收金额由服务端从已生效合同产生或验证。

- [ ] 根据 PRD §§6.5、§7、§8 确认应收、收款登记、分次收款、跨应收分配、核销、退款与冲正的输入/状态/权限契约；不实现在线支付或银行对账。
- [ ] 先为负数/超额、重复提交、并发超额核销、退款/冲正不覆盖原收款、越权查看金额及审计缺失写 pgTAP/API 用例。
- [ ] 在 `udone` 用精确 decimal 数据类型、事务和唯一幂等键实现账款流水、收款、核销及退款命令；批准 RLS/grants 与审计写入在同一可靠边界。
- [ ] 发布账款/收款/核销/退款的版本化 API 契约；重复幂等请求返回第一次业务结果或稳定冲突，不允许 API 端静默浮点换算。
- [ ] 在 `~admin` 实现应收计划、逾期状态、收款录入、核销分配、退款登记、冲正关联和账款明细；敏感操作显示金额/对象/影响并要求原因与确认。
- [ ] 组件测试覆盖金额格式、必填/范围验证及服务器错误；Playwright 覆盖分次收款、核销、拒绝重复/超额、退款/冲正历史；pgTAP/API 验证并发与幂等不变量。
- [ ] 在本地隔离数据库执行并发验证，再在授权 staging 用纯虚构记录验收；输出请求 ID、操作状态与账务核对结果，不用截图替代数据库断言。
- [ ] 更新 PRD traceability、财务运行注意项及 journal。

**负责人默认规则（2026-10-06）：**ERP 端按目标系统交互复刻；目标没有对应行为或无法辨认时采用推荐默认，无需重复询问。收款必须由登记人以外的运营人员使用 `receipt.approve` 审核，通过后才计入实收。应收展期仅允许未结清应收，追加展期记录并保留原到期日；需要 `receivable.write`、填写原因并审计，不额外增加审批。若后续获得清晰目标系统证据，以目标交互更新实现并记录差异。

## Task 6：订阅/授权权益与 `udone` 租户交付

**责任：**权益和租户命令 API/数据库/RLS 在 `udone`；运营操作工作流在 `~admin`。

**依赖：**Task 3 运营权限；Task 4 有效合同/权益快照；Task 5 账款准入规则已实现或由 PRD 明确独立审核条件。

**负责人默认规则（2026-10-06）：**未结清应收不自动阻止授权，但授权生效须独立审批并审计。若后续获得清晰目标系统证据，以目标交互更新实现并记录差异。

- [ ] 按 PRD §§6.6–6.7、§7.1–7.2、§8 设计订阅/授权快照、权益变更审批/执行、租户映射、命令状态和失败重试契约；区分商业权益与 `udone` 运行态。
- [ ] 明确 SaaS 开通、延长、缩减、暂停、恢复、过期处理的合法状态迁移、审批权限、审计原因和与合同/收款的约束；状态不得由前端自造。
- [ ] 为未审批执行拒绝、同一 command 幂等、请求超时后可查询、跨客户租户 ID 拒绝、同步失败不标记成功、已执行操作可审计等场景写 DB/API 测试。
- [ ] 在 `udone` 实现运营命令事务/状态、可信身份和权限检查；调用现有或新增租户 API 时只传明确定义的业务字段，不直接写租户内部表；对外 API 版本兼容策略进入契约。
  > 状态（2026-11-17，`3e34806`）：状态机与可信身份已落地——`dispatching` + 租约 + `claim/complete/reap` 三个 `service_role` 专属函数，pgTAP 38 文件全绿。**「调用租户 API」这半句仍未做**（无 worker、无定时器），故本条不勾。另有一个待修既有缺陷：`record_tenant_command_attempt` 在 `mapping_id` 为空时抛 `record "mapping_entry" is not assigned yet`。详见 `.harness/journal/2026-11-17-tenant-command-dispatch.md`。
- [ ] 发布命令创建/查询/重试、权益查询和同步状态 API。命令需使用持久化幂等键、request ID、可查询状态及失败分类；重试先查询状态。
- [ ] 在 `~admin` 实现授权/订阅详情、权益差异预览、审批后执行、租户映射、同步状态和安全重试；重试前显示上次结果及风险摘要。
- [ ] 组件/Vitest 覆盖状态机和错误映射；Playwright 覆盖权限拒绝、审批前按钮/直接 API 拒绝、执行结果、超时查询、可安全重试；pgTAP/API 覆盖重复命令和隔离。
- [ ] 以 staging 两个虚构运营身份/组织边界验收，不用生产租户；检查失败/恢复证据和 journal。

## Task 7：私有化部署台账与售后工单

**责任：**领域服务、数据与授权 API 在 `udone`；台账、工单页面在 `~admin`。

- [ ] 按 PRD §§6.8–6.9、§7.3 定义私有部署实例标识、版本/授权期限/人工升级记录和工单生命周期/时间线 API；不保存 SSH 或远程登录凭据，不自动部署。
- [ ] 为跨客户实例关联拒绝、未授权敏感字段、工单分派/解决/关闭/重开历史、重复状态命令和审计失败建立测试。
- [ ] 在 `udone` 建立部署记录/升级历史/工单的 migration、RLS、审计和 API；时间线仅追加或保留可追溯变更，不用覆盖旧状态掩盖历史。
- [ ] 在 `~admin` 实现部署实例与客户/合同/授权关联、版本与升级记录；实现工单列表、详情、分派、处理、等待、解决、关闭、重开及时间线。
- [ ] 为售后支持角色限制完整账款/联系方式展示；前端字段脱敏以服务端返回为准。
- [ ] Playwright 覆盖工单完整状态流程、跨客户访问拒绝和台账关联；后端权限/RLS 测试覆盖正反向路径；staging 验收并更新 traceability。

## Task 8：账号配置、审计、总览、报表与导出

**责任：**运营账号/权限、审计、聚合查询、导出 API 在 `udone`；菜单、页面、图表和操作入口在 `~admin`。

- [ ] 按 PRD §§4、§6.1、§6.10、§12 定义运营账号邀请/停用/角色/权限、审计事件、总览指标、导出权限和统一过滤口径的契约；角色名不是后端业务分支，使用权限动作控制。
- [ ] 为自我提权、停用会话写入、导出越权、指标与明细口径不一致、部分依赖故障和不同权限用户访问总览编写 API/DB/组件测试。
- [ ] 在 `udone` 实现账号与权限变更审计、访问审计、异步导出（若数据量触发 PRD 条件）、服务端数据范围、总览聚合查询和请求关联；性能查询避免页面逐项 N+1。
- [ ] 在 `~admin` 实现运营用户/权限配置、审计查询、总览指标及下钻、筛选报表和 CSV 导出；导出继承查询筛选与服务端权限，并记录审计。
- [ ] 验证逾期应收、临期权益、开放工单、SaaS 租户和失败同步指标分别与明细列表同口径；展示更新时间/时间区间，服务异常显示部分失败状态。
- [ ] 使用合成规模数据执行 PRD 性能基线：P95 常规列表/详情 <800ms，复杂报表 <3s；记录数据库查询计划和 Worker/API 时延，不以本地单次浏览器感受作性能证据。
- [ ] Playwright 覆盖账号停用后下一次受保护写拒绝、角色视图、审计可查、总览下钻筛选、CSV 授权与口径一致；更新 PRD traceability。

## Task 9：端到端安全、兼容、部署和首期验收

**责任：**前端部署由 `~admin` 管；Worker、Supabase、迁移和后端发布由 `udone` 管；一次跨项目发布清单协调两边顺序。

- [ ] 建立发布准入表，逐条映射 PRD §11 首期完成定义及 P0 R-ID 到页面/API/migration/RLS/audit/test/staging 证据。
- [ ] 从干净 checkout 验证 Vben frozen install、format/lint/typecheck/tests/build、dependency/license/secret scan；确认分支保护要求检查已启用。
- [ ] 在空的隔离 Supabase 环境重放全量 migration 并运行 pgTAP；验证 `ops` grants/RLS，对匿名、普通租户、失效运营员、未授权角色均拒绝，并验证授权角色允许限定行为。
- [ ] 对前端 API contract 生成结果与 `udone` 权威契约进行差异检查；验证版本不兼容时前端安全失败，不悄悄回退 mock 或直连数据库。
- [ ] 部署 staging 时先核对环境名、API URL、CORS、Auth、Supabase project ref、pending migration 和 secrets 名称；先迁移/发布 Worker，再发布兼容前端；没有批准不得发起 production 部署或删除数据。
- [ ] 使用至少两个虚构客户/租户和全部首期角色执行 UAT：客户到合同、分次收款/核销/退款、授权审批与 SaaS 开通/重试、部署台账、售后、审计、总览/导出。
- [ ] 运行性能测试与并发核销/幂等命令测试；演练备份/恢复和 Worker/API 依赖失败；按 PRD 记录环境依赖、限额和剩余风险，不声称免费计划具有 SLA。
- [ ] 检查日志脱敏、构建产物、权限/跨域拒绝、导出数据、错误关联 ID、恢复证据和前后端部署回滚步骤。
- [ ] 由业务负责人按 PRD 签收已交付功能、环境限制和未纳入范围；所有 required evidence 到位后方可将计划移至 completed；移动位置本身不代表验收通过。

## 验收映射

| PRD 范围 | 计划任务 | 完成证据 |
| --- | --- | --- |
| 工程和模板基线 | Task 1–2 | 上游 SHA/许可、锁文件、本地/CI 门禁成功与负向阻断证据 |
| 账号、角色、运营身份 | Task 3、8 | API 集成、pgTAP、Playwright 与停用会话拒绝证据 |
| 总览与下钻 | Task 8 | 指标/明细一致性、权限范围、性能结果 |
| 客户、产品、套餐、合同、续约 | Task 4 | API/迁移/RLS/审计/页面状态/端到端合同快照验收 |
| 应收、线下收款、核销、退款 | Task 5 | 金额精度、并发、幂等、流水不可覆盖和审计证据 |
| 订阅、授权与租户同步 | Task 6 | 审批前拒绝、命令状态查询、幂等重试和跨系统 staging 证据 |
| 私有化部署与售后 | Task 7 | 人工台账、工单时间线、角色字段限制和集成测试 |
| 配置、审计、导出、报表 | Task 8 | 服务端权限、过滤口径、审计与受控导出证据 |
| 安全、性能、恢复、上线 | Task 9 | 空库迁移、真实 staging UAT、性能报告、恢复/回滚演练、签收 |

## 计划自审

- **边界：**前端源码和发布归 `~admin`；API、运营 schema/RLS/迁移和租户变更归 `udone`。不复制数据库真源、不建立独立重复后端。
- **需求覆盖：**PRD 首期范围中客户、产品套餐、合同账款、权益租户、私有部署、售后、账号审计、总览导出均映射到 Task 3–9；线索漏斗、在线支付、电子签、自动私有化部署、AI 和客户门户按 PRD 排除。
- **工程覆盖：**导入版本/许可、锁定工具链、质量 CI、依赖与许可证、secret scan、数据库/RLS 测试、真实 E2E、性能、部署隔离和恢复均有任务及证据。
- **不确定性控制：**计划不虚构现有 API 字段、物理表和 RLS 名称；每个域先以 PRD 和 `udone` 当前实现核对契约，再实现后端并由后台消费。
- **安全验收：**跨身份和跨数据域不仅测 UI；API 与 PostgreSQL 测试证明授权与拒绝。mock 不代替数据库或 staging 证据。
- **实施状态（2026-10-08）：**Task 1 已完成。Task 2 的本地 `quality:check` 后续在负责人批准的两个精确 dev-only high advisory 临时例外下通过；例外仍需到期复审，托管 CI/分支保护未验证。Task 3–8 的前后端本地切片已有独立 worktree、提交和调度记录，但缺真实 staging、浏览器端到端及其他计划验收证据，整体任务仍未关闭。Task 9 本地集成已启动，尚未完成：当前后端空库重放发现迁移版本重复，前端执行对话遇到 PowerShell/进程内存故障；两端 worktree 均有未提交改动，均须保留并由各自执行者闭环。Task 9 全部验收项继续未勾选。本计划不表示运营业务已完成集成、真实环境验收或发布。
