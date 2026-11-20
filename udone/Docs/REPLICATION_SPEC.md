# 旅行社 OMS 复刻规格 — 唯一有效口径

版本：1.0；整理日期：2026-10-02（Asia/Shanghai）；目标：飞途 OMS v3.7，授权测试租户泫蜗旅行。

本文件是本项目复刻的唯一有效规格。旧版规格和阶段报告已清理；当前状态只维护于本文件及 `research/evidence/` 中的原始证据。`research/evidence/` 保存原始脱敏证据；证据优先于总结文字。后续补测直接更新本文件相关条目，不再另建平行完成度报告。

截至 2026-10-02 的当前结论：授权账号已完成真实登录并取得业务请求/响应证据；核心订单、游客、附件、收付款及两级审批链已补测。仍未验证的主要范围是第二租户隔离、同角色本人/全部数据范围、CRM 成功链（目标站创建线索返回 500）、外部支付/消息以及真实数据库结构。

阅读导航：

- [范围与证据口径](#1-使用原则与复刻范围)、[页面与交互](#2-页面与交互规格)
- [状态与操作](#3-状态与操作)、[金额与报表](#4-金额与报表的唯一口径)
- [权限与数据设计](#5-身份权限数据关系与安全设计)、[AI](#6-ai-规格与待决策行为)
- [验收场景](#7-复刻验收清单)、[统一缺口](#8-统一缺口与决策清单)
- [字段字典](#9-字段字典)、[路由与接口](#10-目标路由与接口参考)
- [逐功能范围](#11-逐功能覆盖与剩余范围)、[证据索引](#12-证据索引与历史来源)、[清理记录与维护](#13-测试租户清理记录与后续维护)
- [本轮浏览器补测进度](#14-agent-browser-补测进度2026-10-02)

## 1. 使用原则与复刻范围

目标是还原旅行社内部运营后台：线索、客户和基础资料 → 订单与团期 → 应收应付 → 收付款申请和审批 → 结算、余额、经营报表。订单详情是业务聚合入口。

当前材料可指导核心业务及主要页面开发。未确认的状态迁移、权限范围、财务异常和外部集成按第 8 节补测或决策后实施。复刻产品行为与工程技术决策分开维护：技术栈、数据库和部署以 `TECH_SELECTION.md` 为准；目标站概念数据模型不代表本项目物理 schema。

采用四种证据口径：

- **报文可核验**：存档中有对应 method、URL、请求字段或响应元数据。只证明实际保存的字段，不等于完整响应体或流程成功。
- **页面可核验**：有 DOM 快照，可证明页面结构、字段、枚举、按钮和文案；HTML required 不等于服务端必填规则。
- **执行记录**：历史调研记录了提交及回读结果，但未保存该操作的独立报文或最终页面快照。可用于功能实现参考，验收时需在复刻系统重现。
- **待验证 / 设计建议**：没有足够证据，或属于新系统的设计选择；不得写成目标站既有事实。

同一条规格可同时具备不同证据：字段来自 DOM、业务结果来自执行记录、请求仅有元数据。按属性分别判断，不给整个模块笼统打“全部完成”。第 9–11 节分别保存字段、接口和逐功能范围。

## 2. 页面与交互规格

### 2.1 导航与页面布局

- 业务导航：仪表盘、新建订单、订单管理、收款管理、付款管理、批量结算、账户余额、审核工作台、经营分析、业绩统计、CRM。
- 基础资料：地区、供应商、线路、客户、操作日志。
- 系统：公司设置、用户、角色权限。公司设置含公司信息、操作安全、付款方式、线路类型、供应商类型、审批流程、出发城市、客户来源、订单设置。
- CRM：仪表盘、线索列表、公海、回收站、设置。
- 左侧纵向导航，顶栏呈现用户、角色、公司和服务期限。列表由筛选、状态页签、汇总、表格、分页组成；订单支持列表和日历。
- 无记录显示空态及新增入口；有数据的列、按钮、表单按页面快照还原。现存证据没有截图，配色、尺寸、断点和像素级布局需另行补充，不能将 DOM 覆盖等同于视觉一比一。
- 公司侧栏主题取 `dark` / `light`；字号、Logo 有配置字段。只有主题保存有执行记录，不能将其扩大为所有配置均已验证。
- 高影响操作显示确认文案与影响；被引用供应商删除按钮禁用并说明原因。

页面依据：`research/evidence/pages/`，页面 URL 与文件索引见第 12 节。

### 2.2 各模块内容

**仪表盘**：今日有效订单、进行中订单、待我审核、本月已收、待审核收付款、待收/待付订单、资金趋势、CRM 摘要、风险提醒、近期出发及最近有效订单；有新建订单、申请收付款和审核入口。卡片逐项下钻尚未验证。

**订单**：列表展示订单号、客户/来源、产品/地区、团期、供应商、金额、未收、应付/未付、利润、收付进度、状态和创建人。新建为同一长表单，通过 `order_type` 切换正式/预订单。分区为客户与人数、线路与团期、基础及其他应收、基础及其他应付、合同附件、金额摘要。动态明细、总价覆盖和异常组合需单独验收。详情含财务项目/流水、游客、附件及状态操作。

**收付款**：按订单分组，申请先选订单再选应收/应付项目；显示申请金额、方式、凭证、用途与审批进度。付款自动带出供应商联系人，提供批量结算。系统记录内部收支；现有证据没有银行/支付通道真实交易。

**CRM**：姓名/联系方式、目的地、出发城市、日期、人数、预算、来源、出游类型、意向、阶段、跟进、创建人/负责人。已记录新线索创建及推进到需求沟通；公海认领、转客户/转订单和完整漏斗统计仍需补测。

**客户及基础资料**：客户含来源、证件、生日、备注、标签及订单消费摘要；线路含类型、地区、出发城市、天数、自组团属性；供应商含类型、结算方式、联系人、状态和引用摘要。客户生日落库与性别来源不明确。

**审核与报表**：工作台按当前审批级次呈现待办；经营分析含总览、订单明细和供应商统计，可切日期范围及日期字段；业绩按创建人等维度展示。指标口径见第 4 节，所有数据范围需独立验证。

## 3. 状态与操作

### 3.1 订单

列表 DOM 枚举：`booking` 预订单、`active` 进行中、`completed` 已锁团、`cancelled` 已取消、`to_lock` 待锁团。`order_type=active|booking` 来自后续执行记录；早期字段字典中的 `formal` 已撤销，接口请求未取得可核验业务取值，补测时确认实际提交值。

有效迁移及依据：

- 新建正式订单 → `active`，新建预订单 → `booking`：执行记录；新建 POST 请求元数据在网络文件中存在。
- `booking` → `active`：确认出团，`POST /orders/{id}/confirm-booking`，有二级确认。订单 1071 仅留请求侧报文；第四轮订单 1072 的成功来自执行记录，不能合并成同一次抓包。
- `active` → `completed`：锁团，`POST /orders/{id}/complete`。记录了收款仅 40% 时成功，不能自行加上“收付款必须 100%”条件。
- `completed` → `active`：解锁，`POST /orders/{id}/unlock`，页面 `reason` 必填。锁团后编辑入口受限；服务端绕过编辑的负向用例需补测。
- `active` → `cancelled` → `active`：取消、恢复，分别为 `/cancel`、`/recover`，来自执行记录。
- `active` → `booking`：`POST /orders/{id}/mark-booking`，本轮订单 1073 成功回读为预订单；再经 `/confirm-booking` 回到进行中。
- 对账仅改变对账标记，保持订单状态；确认与取消分别为 `POST /orders/batch-reconcile`、`POST /orders/batch-unreconcile`，本轮均成功。
- 批量删除进入订单回收站，本轮订单 1073 已验证并经页面双重确认恢复到进行中；恢复表单声明操作密码检查点，但该次页面流程没有再出现密码输入框。彻底删除不可恢复，不执行。
- `to_lock` 的生成条件、自动锁团、取消对历史收付款及报表的影响未确认。

来源：订单列表/详情/编辑/回收站快照；2026-10-02 执行记录已归纳于本规格第 14 节，原始页面/网络证据保留于 `research/evidence/`。

### 3.2 收付款与审批

测试配置为财务 → 公司管理员两级审批。收款和付款各自提交、逐级审批，最终自动变为已收款/已付款，没有独立人工确认步骤。该结论限于测试配置；关闭自动确认后的流程尚未跑通。内部审计出现“第0级”，用户界面按第 1 / 2 级解释。

创建申请 → 财务待审 → 管理员待审 → 已确认收款 / 已付款，本轮已用收款 300 元和付款 200 元重新跑通。收款还验证了财务驳回 → 编辑补充 → 重提 → 财务通过。最终确认后 `/undo-approve` 撤回会回到“待管理员审核”，已确认金额同步回滚，财务首审保留。申请人在本轮同时是管理员，仍可做第二级终审，因此目标站当前配置不是全面禁自审。申请撤回、退款/冲正尚未验证。

本轮实际路由为 `/review/{customer-payments|supplier-payments}/{id}/reject`、`approve`、`undo-approve`。驳回字段为 `reject_reason`。旧记录中的 `/withdraw`、`/undo` 404 不能继续作为当前路由结论。是否允许同一级审批人审批自己创建的申请，需作为新系统明确的策略，而非照搬“禁自审”假设。

审批配置字段包括角色、指定人、自动确认及撤回开关；配置保存、变更中的审批实例、代理/越级与并发审批需要补测。

### 3.3 游客、附件、批量结算和 CRM

- 游客弹窗支持逐行填写和 CSV 导入。模板路径为 `/templates/tourist_import_template.csv`，表头为姓名、手机、证件类型、证件号、成人/儿童、年龄、性别、备注。导入采用追加模式；本轮 1 位已有游客再导入 1 位后变为 2 位。订单申报 1 成人而名单有 2 成人时页面只显示差额警告，仍允许保存，不能实现成强制人数一致。
- 合同及收付款凭证 PDF 均已成功上传。授权会话访问本轮合同返回 200 / `application/pdf`；未登录会话访问同一文件被重定向登录页。同租户不同员工及跨租户对象级文件鉴权仍未验证。
- 批量结算为 `POST /supplier-payments/batch-settle`；选应付明细、填写日期/方式/金额、第二层复核明细后提交。记录了应付 2300 → 已付 2300 / 未付 0。审批是否被该路径跳过、重复结算和月结规则需要补测。
- 线索阶段可见新线索、需求沟通、报价中、方案确认、已成单、已放弃；只记录了新线索 → 需求沟通。跟进与阶段同次提交，路径 `/leads/{id}/follow-ups`，字段 `stage` / `content` 来自执行记录。

## 4. 金额与报表的唯一口径

- 应收 / 应付来自订单明细；利润 = 应收合计 − 应付合计。
- 毛利率 = 利润 ÷ 应收；客单价 = 订单总额 ÷ 人数。
- 已收仅计已确认收款，已付仅计已付款；净现金流 = 已收 − 已付。
- 待审收款会占用额度。超出具体应收项目剩余额度时服务端拒绝，并返回“金额超出项目剩余可收”提示；驳回后释放额度，重提后重新占用。待审不计入已收，终审后计入已收；`undo-approve` 后回滚已收但继续占用在途额度。
- 最终收款 3000、付款 4800：利润 2700，毛利率 36%，收款进度 40%，付款进度 100%，客单价 2500，净现金流 −1800。
- 经营分析订单总数口径为进行中 + 已锁团；已取消不计入该总数。其他状态及不同日期筛选的完整金额统计范围需补测。
- 账户余额按付款方式分账户：期初 + 已确认收款 − 已付款；样例微信 +3000、建设银行 −4800，总余额 −1800。
- 页面金额为人民币符号、千分位及两位小数。币种扩展、税、舍入精度、零分母、负数/超额、退款、提成与历史调整均未确定。
- 行备注出现成人/儿童报价与成本计算式；这证明保存后展示结果，不足以证明服务端对篡改金额已重算。服务端重算和定点金额属于复刻设计要求，需做篡改输入用例。

依据：`research/evidence/pages/reports_with_data.json`、`statistics_with_data.json`、`balances_with_data.json`、`order_detail_1069.json`，以及历史业务链具体数字。

## 5. 身份、权限、数据关系与安全设计

### 5.1 目标站已观察信息

角色代码为 `company_admin`、`operator`、`finance`；权限页观察到 60 项，历史计数管理员 60、计调员 32、财务 41。角色权限保存有 32 → 33 → 32 的执行记录；不能据计数推导角色完整授权矩阵。权限代码范围见第 9 节，精确列表以角色 DOM 为依据。

用户名全公司唯一为页面说明；手机号可重复、一账号多租户和身份切换的实际模型未验证。租户名、用户/存储配额和服务期限为测试快照，不能固定成所有租户规则。

会话 Cookie + CSRF 隐藏字段 `_token`，部分 AJAX 使用 `X-CSRF-TOKEN`；编辑/删除出现 POST + `_method=PUT|DELETE`。目标站以 HTML 页面和表单路由为主，少量 JSON 请求。原 `/api/v1`、统一响应封套、游标分页和幂等键均为旧设计推演。

### 5.2 复刻项目的设计要求（不是目标数据库事实）

业务关系：公司 → 用户/角色/字典/配置；订单 → 客户、线路/地区、团期、游客、附件；订单 → 多条应收/应付；收付款申请 → 订单及项目；审批动作 → 申请；报表从授权范围内的订单及确认收付汇总；审计关联操作者、对象及动作。线索与客户/订单的转换关系仍待明确。

数据库 schema、主外键、索引、金额类型和物理隔离未知。复刻自行设计存储，满足以下要求：

- 服务端确定租户上下文；查询、变更、关联对象、文件与导出均校验租户及对象权限。
- 本人/全部数据范围与功能权限分别处理；待办按当前审批级次计算。跨租户及同租户不同员工需要独立测试数据。
- 财务提交/审批/结算应防止重复记账和超额竞争；历史财务记录、引用和审计保持可追溯。
- 金额使用精确十进制；字典可考虑稳定 ID + 名称快照。目标站付款方式提交名称、线索目的地与出发城市提交文本，兼容层与内部模型可不同。
- 展示掩码不得写回真实字段。编辑页观察到掩码手机号，实际覆盖保存未独立留证，但应避免该风险。
- 被引用主数据删除必须有前置校验及明确反馈；用户删除失败原因、软删除级联和审计保留不能自行推成目标规则。
- 停用账号登录已被拒；现有会话是否即时失效尚未验证，新系统应明确会话失效策略。

## 6. AI 规格与待决策行为

已保存 `POST /orders/ai-parse` 的请求和 200 元数据，请求 JSON 字段为 `raw_text`。历史记录包含响应结构：`success`、结构化 `data`、字段状态 `fields`（`ok|required|suggested`）和 `enriched`（客户/供应商/线路）。结构化字段及响应样例见第 10 节。

历史回读记录说明解析同时创建客户和线路，并返回 `_customer_id` / `_route_id`。没有证据表明这一步创建订单。模型供应商、提示词、工具链、额度和一般流式能力未知；本次记录为单次 JSON 返回。

复刻需决定是否保留自动建档案行为。推荐解析生成建议 → 用户复核 → 显式创建或关联档案；这是行为改动建议，不能默认为已批准。CRM AI 工作建议未验证。多智能体编排与工具执行均不属于已观察产品事实。

## 7. 复刻验收清单

以下是复刻系统应重现的场景，不是已开发系统的通过报告。每项保留测试输入、实际输出和回读证据；目标站来源为页面证据或历史执行记录，不能据此省略新系统验收。

1. 登录成功进入公司工作台；停用用户登录被拒；菜单按角色展示。
2. 创建供应商、线路、客户并回读；空客户姓名被服务端拒绝。
3. 新建正式/预订单；客户和线路选择联动；人数由成人 + 儿童计算。
4. 使用 2 成人、1 儿童，应收 7500、应付 4800，验证利润 2700、毛利率 36%、客单价 2500。
5. 申请收款 3000 时显示待审核，已收不增加，未收额度变 4500。
6. 财务审批后进入管理员级；最终审批自动确认收款。付款 4800 完成对应两级流程。
7. 已收 3000、已付 4800 时，净现金流与账户总余额均为 −1800。
8. 收款仅 40% 时手工锁团，锁团后编辑受限；填原因解锁回进行中。
9. 预订单确认出团后变进行中；该命令与通用编辑分别验证。
10. 取消后可恢复；对账不改变订单状态；删除订单进入回收站。
11. 被引用供应商删除受阻并显示原因；软删除订单仍可能占引用。
12. 游客保存 3 人后计数更新；填写过程中显示成人/儿童差额。
13. 上传合同后附件计数和存储展示变化。
14. 批量结算二次确认明细；应付 2300 付清后已付 2300、未付 0。
15. 修改角色权限、公司主题后刷新可回读，恢复原值。
16. 新线索推进到需求沟通并记录跟进。
17. 日历返回按日期分组的出发 `dep` / 回团 `ret` 数据。
18. 订单导出返回 CSV；文件字段、内容与权限过滤按补测结果另定。
19. 审计显示时间、操作者、对象、动作与详情；已记录审批级次文案。
20. AI 返回字段建议；自动建档案行为按第 6 节确认的方案验收。

额外设计验收：跨租户、本人/全部范围、文件/导出鉴权、金额篡改、重复提交、并发审批与结算、停用会话和掩码编辑保护。这些是新系统的工程验收要求，现有目标站材料未证明全部通过。

## 8. 统一缺口与决策清单

### 8.1 开发前需明确的业务行为

- `to_lock` 与自动锁团、进行中转预订单、订单取消对财务的影响。
- 申请撤回、退款/冲正、重复结算、月结规则；驳回重提、终审撤回、超额拦截和部分收付已有本轮实测。
- 同一级自审/越级/代理、配置变更对在途申请的作用、关闭自动确认后的流程。当前租户已证明创建人可在管理员级终审自己提交的申请。
- CRM 认领/分配/超时回收、转客户/转订单、去重与再次转换。
- AI 自动建档案、删除/恢复保留规则、字典改名与停用对历史单据的影响。

### 8.2 仍需补测的功能及证据

- 动态应收应付异常组合、总价覆盖与服务端重算。快捷新增客户/线路/供应商及客户标签 CRUD 已完成本轮实测。
- 标签关联、来源层级维护、客户生日/性别、地区完整 CRUD/查重、业务字典全部增删改。
- 通知面板内容/已读/投递。原始网络含通知轮询及一条标记已读请求，不能继续写“完全没请求”，也不代表通知全链路通过。
- 游客 CSV 的模板、有效导入、追加行为和人数差额警告已验证；畸形 CSV、逐行失败明细及其他模块导入仍需补测。
- 订单 CSV 内容已取得；仍需验证筛选条件、不同角色数据范围。合同/凭证上传与登录门禁已验证；同租户对象权限、跨租户权限和 20MB 服务端限制仍缺。
- CRM 有数据漏斗/排行、统计下钻、提成、自组团口径、日期范围、零分母与取消状态的统计变化。
- 公司 Logo/字号/资料全部保存、审批/订单/操作安全配置持久化及效果。
- CRM 创建线索本轮完整字段提交返回 HTTP 500，列表未新增，因此跟进、转客户/订单及公海闭环被目标站错误阻断。
- 尚未重跑的关键写接口完整请求字段、响应状态与响应体；本轮新增链路已有独立脱敏证据。
- 视觉截图及窄屏布局；现有材料为 DOM，无法完成像素级比对。

### 8.3 需要额外资料或授权的部分

- 真实数据库结构：schema、迁移或服务端源码；如目标仅为功能复刻，可自行设计，不必等待原 schema。
- 第二个授权租户及同租户不同员工账号，用于隔离与数据范围验证。
- 身份跨租户模型、租户到期/停用行为及套餐规则。
- 外部支付、消息、OTA、电子合同等是否进入复刻范围；现有证据不能证明这些集成存在。

不使用整体“80%”“接口 88%”评分。这些旧估计没有统一分母，无法用作项目门禁；按具体场景及证据缺口排期。

## 9. 字段字典

字段来自页面或历史提交记录；表内“必填”默认指页面 required，只有空客户姓名拒绝有单独服务端执行记录。固定 ID、日期和账号是测试样例，不是产品常量。附录内已统一更正过期取值与未证实的规则。

### 9.1. 登录 /login（POST）

| 字段 | 类型 | 必填 | 说明 | 等级 |
|---|---|---|---|---|
| `_token` | hidden | 是 | CSRF，值不记录 | 字段观察 / 执行记录 |
| `username` | text | 是 | 用户名或手机号 | 字段观察 / 执行记录 |
| `password` | password | 是 | 值不记录 | 字段观察 / 执行记录 |
| `remember` | checkbox | 否 | 记住我 | 字段观察 / 执行记录 |

登录失败反馈（实测）：已禁用账号提交后提示「该账号已被禁用，请联系管理员」。

### 9.2. 订单（POST /orders，multipart）

| 字段 | 类型 | 默认 | 必填 | 说明 | 等级 |
|---|---|---|---|---|---|
| `from_ai` | hidden | `0` | — | 是否来自 AI 解析 | 字段观察 / 执行记录 |
| `order_type` | hidden | `active`（执行记录） | — | `active` 正式 / `booking` 预订；报文业务取值待补测 | 执行记录 |
| `customer_id` | hidden | — | 否 | 选已有客户后回填（实测 813） | 字段观察 / 执行记录 |
| `customer_name` | text | — | **是** | 可手填或由选择客户回填 | 字段观察 / 执行记录 |
| `customer_phone` | text | — | 否 | | 字段观察 / 执行记录 |
| `adult_count` | number | `1` | 否（HTML 未标 required） | | 字段观察 / 执行记录 |
| `child_count` | number | `0` | 否 | | 字段观察 / 执行记录 |
| `number_of_people` | hidden | — | — | **表单中出现两次**（客户区/供应商区） | 字段观察 / 执行记录 |
| `region_id` | select | — | 否 | 地区树 ID（实测 910=广州） | 字段观察 / 执行记录 |
| `route_id` | hidden | — | 否 | 选线路后回填（实测 477） | 字段观察 / 执行记录 |
| `product_name` | text(readonly) | — | **是** | 由线路选择回填，只读 | 字段观察 / 执行记录 |
| `tour_code` | text | 占位 `YN-0501` | 否 | 团号 | 字段观察 / 执行记录 |
| `booking_date` | text | 当天 `2026-10-01` | **是** | 预定日期 | 字段观察 / 执行记录 |
| `departure_date` | text | — | **是** | 出团日期 | 字段观察 / 执行记录 |
| `return_date` | text | — | **是** | 回团日期 | 字段观察 / 执行记录 |
| `product_details` | textarea | — | 否 | 行程亮点等 | 字段观察 / 执行记录 |
| `order_unit_price` | number | — | **是** | 成人单价 | 字段观察 / 执行记录 |
| `order_child_unit_price` | number | — | 否 | 儿童单价 | 字段观察 / 执行记录 |
| `total_amount` | number | — | **是** | 订单金额（可手填覆盖） | 字段观察 / 执行记录 |
| `order_total_remark` | text | — | 否 | 如优惠/折扣 | 字段观察 / 执行记录 |
| `supplier_id` | hidden | — | 否 | 实测 387 | 字段观察 / 执行记录 |
| `supplier_adult_unit_price` | number | — | **是** | | 字段观察 / 执行记录 |
| `supplier_child_unit_price` | number | — | 否 | | 字段观察 / 执行记录 |
| `supplier_cost` | number | `0.00` | **是** | 供应商成本总额 | 字段观察 / 执行记录 |
| `supplier_people` | hidden | — | — | | 字段观察 / 执行记录 |
| `supplier_cost_remark` | text | — | 否 | | 字段观察 / 执行记录 |
| `contract_files[]` | file | — | 否 | 图片/PDF/Word，页面文案 20MB | 前端声明 |

**联动（实测）**：选线路 → 自动回填 `product_name`、`route_id`、`region_id`。选客户 → 回填 `customer_id/name/phone`。

**保存后计算式展示（执行记录，服务端篡改输入校验待测）**：应收行备注自动写入「报价：¥7,500.00 = ¥3,000.00×2人 + ¥1,500.00×1人」；应付行写入「成本小计：¥4,800.00 = ¥2,000.00×2人 + ¥800.00×1人」。

### 9.3. 订单状态枚举（实测 select option value）

| value | 页面名称 |
|---|---|
| `booking` | 预订单 |
| `active` | 进行中 |
| `completed` | 已锁团 |
| `cancelled` | 已取消 |
| `to_lock` | 待锁团 |

来源：`/orders` 列表筛选 select 的 option value（字段观察 / 执行记录）。

### 9.4. 订单行（GET /orders/order-items/options 响应）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | number | 实测 2911（应收）/ 2912（应付） |
| `name` | string | 基础团款 / 基础成本 |
| `remark` | string\|null | 实测为 null |
| `amount` | number | 7500 |
| `remaining` | number | 7500 |
| `effective_remaining` | number | 7500（与 remaining 关系待验证：超额/部分收付场景） |
| `supplier_id` / `supplier_name` / `supplier_contact` / `supplier_phone` | number\|string\|null | 应收行为 null；应付行带出供应商（字段观察 / 执行记录） |
| `label` | string | 展示文案「基础团款 ¥7,500.00（剩 ¥7,500.00）」 |

### 9.5. 收款申请（POST /customer-payments）

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `order_id` | select | 是 | 选项文案「ORD… - 客户 (已收 ¥0.00 / ¥7,500.00)」 |
| `order_item_id` | select | 是 | 选订单后由 AJAX 加载 |
| `amount` | number | 是 | 支持部分金额（实测 3000 / 7500） |
| `payment_method` | select | 是 | **提交方式名称**（微信/建设银行…），非 ID；停用的招商银行不出现在选项 |
| `receipt_no` | text | 否 | 凭证号 |
| `bank_transaction_no` | text | 否 | 银行流水号 |
| `receipt_files[]` | file | 否 | 多选，支持 Ctrl+V 粘贴 |
| `remark` | textarea | **是** | 款项用途及备注 |

### 9.6. 付款申请（POST /supplier-payments）

同上，另加：`supplier_name`（hidden，自动回填）、`supplier_contact`、`supplier_phone`（自动带出）、`invoice_no`、`account_no`（textarea，收款账号/系统号）、`invoice_files[]`。

### 9.7. 供应商（POST /suppliers）

`name`(必填) / `type`(select，默认空，选项含地接公司…导游) / `settlement_type`(select，默认 `non_monthly`) / `contact_person`(必填) / `contact_phone`(必填) / `remark` / `is_active`(checkbox)。

### 9.8. 线路（POST /routes）

`name`(必填) / `route_type_id`(必填，选项 ID 384–395) / `region_id`(必填，地区树 ID 907–935) / `departure_city`(必填，**存文本**如「广州」) / `days`(number，默认 0) / `description` / `is_group`(checkbox) / `target_headcount`(默认 30) / `group_deadline` / `is_active`。

### 9.9. 客户（POST /customers）

`name`(必填) / `phone`(必填) / `email` / `id_number` / `customer_source_id`(必填，来源树 ID 1542–1585+) / `birthday`(text) / `birthday_calendar`(solar/lunar，默认 solar) / `remark`。
**注意**：创建表单无性别字段，但列表有「性别」列（显示 —）——性别来源待验证。实测填入 birthday 后列表仍显示「—」，生日是否落库**待验证**。

### 9.10. 线索（POST /leads）

`name`(必填) / `phone`(必填) / `email` / `source_id`(来源树 ID) / `destination`(**存文本**，如「广东省内」「└ 广州」) / `departure_city`(**存文本**) / `route_type_id`(ID) / `intent_level`(**存文本** 高/中/低) / `departure_date` / `budget_min` / `budget_max` / `adult_count` / `child_count` / `remark`。

**与订单的差异**：订单用 `region_id`（ID），线索用 `destination`（文本）——这是目标表单的差异；内部统一 ID 与快照属于设计选择。

### 9.11. 用户（POST /users）

`name`(必填) / `username`(必填，**全公司全局唯一**) / `email` / `password`(必填) / `phone` / `role`(必填：`company_admin`/`operator`/`finance`) / `is_active`(checkbox)。

### 9.12. 审批配置（POST /settings/approval，前端声明）

`receipt_role_0/1`、`receipt_user_0/1`、`receipt_executor_enabled`、`receipt_executor_role`、payment 同名系列、`undo_when_exec_disabled`。页面配置快照：收款/付款各 2 级，第 1 级 `finance`、第 2 级 `company_admin`，指定人「任何人」，executor 角色 `finance`。

### 9.13. 权限代码（实测 60 项，`permissions[]`）

订单：`order.view` `.view.own` `.create` `.edit` `.edit.own` `.delete` `.delete.own` `.approve` `.cancel` `.recover` `.complete`（锁团和对账）`.unlock`
收款：`customer-payment.view/.create/.edit/.delete/.approve`、`customer-refund`
付款：`supplier-payment.view/.create/.edit/.delete/.approve/.batch-settle`
余额：`account-balance.view/.edit`
报表：`report.view/.finance/.export`
业绩：`statistics.view/.view.own`
CRM：`crm.view/.view.own/.create/.edit/.edit.own/.delete/.assign/.export`
基础数据：`region.*`、`route.*`、`customer.*`、`supplier.*`（各 view/create/edit/delete；精确项以角色 DOM 为准）
系统：`user.manage`、`settings.manage`、`audit-log.view`、`audit-log.view.own`、`profile.password`

角色权限计数（实测）：管理员 60（订单 12/收款 5/付款 6/经营分析 3/业绩 2/基础数据 28/系统 4）；计调员 32；财务 41。

### 9.14. 展示与脱敏（实测）

- 客户电话在订单详情显示 `138****8001`（中间 4 位掩码）。
- 用户列表对既有账号显示 `158****6269`；新建测试手机号在列表中显示为完整值——脱敏触发条件**待验证**。
- 金额统一 `¥` + 千分位 + 2 位小数；百分比取整（36%）。

### 9.15. 后续执行记录补充字段

游客：姓名、手机、证件类型、证件号、成人/儿童类型、年龄、性别、备注；证件类型文案为身份证/护照/港澳通行证/台胞证。只有姓名和证件号标为必填，数组键名/请求 schema 待抓包。

角色保存：`permissions[]`。公司设置：`company_name/company_short/company_phone/company_address/sidebar_theme/app_font_size/company_logo/delete_logo`，Logo 删除控件的实际编码仍需补测。

批量结算：`orders[项目键][id|supplier_id|order_item_id|amount]`、`payment_date/payment_method/remark/invoice_files[]`；精确索引键和关联 ID 含义待完整请求证实。



## 10. 目标路由与接口参考

核对结果：40 个目录条目中，15 个可匹配存档请求，25 个没有匹配；这是条目级匹配数量，不是完整契约覆盖率。

旧目录有 40 个条目，其中 2 个是页面路径集合，不能称为 40 个独立接口。以下逐条以存档请求重新核对；不继承旧 `capture`/`confirmed` 标签。未留证的 HTTP 状态码不进入有效契约。请求及响应参考字段来自旧目录和页面，仅有原始报文匹配时才标为报文可核验。

每条路由分别列出请求侧、响应元数据、历史结果及来源。原有 19 份网络 JSON 只保存 `status/responseHeaders/mimeType` 等元数据，没有响应 body 字段；options、calendar、AI 的 JSON 结构属于历史响应摘录，不能称为原始完整响应体已存档。后续新增请求详情及补测进度见第 14 节。

### 10.1. `GET /login`

页面/动作：打开登录页。

存档核验：存在对应请求元数据；没有可用请求 postData；响应状态 200；无原始响应体。

报文文件：[network_01_login.json](research/evidence/network_01_login.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_status": 200,
  "historical_content_type": "text/html; charset=utf-8"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 1；第 3–8 节的统一规则优先。

### 10.2. `POST /login`

页面/动作：提交用户名密码。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token",
    "username",
    "password",
    "remember(checkbox, 未勾选时不存在)"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_01_login.json](research/evidence/network_01_login.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_status": "302(重定向至 /)"
}
```

字段/行为备注：密码与 _token 值在证据中已替换为 [REDACTED]。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 2；第 3–8 节的统一规则优先。

### 10.3. `POST /logout`

页面/动作：退出登录。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 3；第 3–8 节的统一规则优先。

### 10.4. `POST /password/update`

页面/动作：修改密码弹窗。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "current_password",
    "new_password",
    "new_password_confirmation"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 4；第 3–8 节的统一规则优先。

### 10.5. `POST /suppliers`

页面/动作：添加供应商保存。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token",
    "name",
    "type",
    "settlement_type",
    "contact_person",
    "contact_phone",
    "remark",
    "is_active"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_03_supplier_create.json](research/evidence/network_03_supplier_create.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_status": "重定向回 /suppliers，列表出现新记录"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 5；第 3–8 节的统一规则优先。

### 10.6. `POST /routes/{id}`

页面/动作：删除线路。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "_method=DELETE"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_08_cleanup.json](research/evidence/network_08_cleanup.json)。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 6；第 3–8 节的统一规则优先。

### 10.7. `POST /customers/{id}`

页面/动作：删除客户。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "_method=DELETE"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_08_cleanup.json](research/evidence/network_08_cleanup.json)。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 7；第 3–8 节的统一规则优先。

### 10.8. `POST /customers`

页面/动作：必填校验（绕过前端 required 后提交空表单）。

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_04_master_data.json](research/evidence/network_04_master_data.json)。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 8；第 3–8 节的统一规则优先。

### 10.9. `POST /orders`

页面/动作：创建订单提交。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "multipart/form-data",
  "body_fields": [
    "_token",
    "from_ai",
    "order_type",
    "customer_id",
    "customer_name",
    "customer_phone",
    "adult_count",
    "child_count",
    "number_of_people",
    "region_id",
    "route_id",
    "product_name",
    "tour_code",
    "booking_date",
    "departure_date",
    "return_date",
    "product_details",
    "order_unit_price",
    "order_child_unit_price",
    "total_amount",
    "order_total_remark",
    "supplier_id",
    "supplier_adult_unit_price",
    "supplier_child_unit_price",
    "supplier_cost",
    "supplier_people",
    "supplier_cost_remark",
    "contract_files[]"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_05_order_create.json](research/evidence/network_05_order_create.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "order_no": "ORD2026100100005",
  "historical_status": "重定向至 /orders/1069"
}
```

字段/行为备注：number_of_people 在表单中出现两次（客户区与供应商区各一个隐藏域）。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 9；第 3–8 节的统一规则优先。

### 10.10. `POST /orders/{id}/complete`

页面/动作：点击锁团并确认。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 10；第 3–8 节的统一规则优先。

### 10.11. `POST /orders/{id}/unlock`

页面/动作：点击解锁并填写原因。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token",
    "reason"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：解锁原因为必填（textarea required）。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 11；第 3–8 节的统一规则优先。

### 10.12. `POST /orders/batch`

页面/动作：勾选订单后点击批量删除。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token",
    "batch_action=delete",
    "ids[]"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_08_cleanup.json](research/evidence/network_08_cleanup.json)。

字段/行为备注：批量条还提供 确认对账 / 取消对账 / 批量锁团。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 12；第 3–8 节的统一规则优先。

### 10.13. `GET /orders/order-items/options`

页面/动作：选择订单后加载应收/应付项目。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "query": [
    "order_id",
    "type=receivable|payable"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "shape": "数组[{id, name, remark, amount, remaining, effective_remaining, supplier_id, supplier_name, supplier_contact, supplier_phone, label}]",
  "sample_redacted": {
    "id": 2911,
    "name": "基础团款",
    "remark": null,
    "amount": 7500,
    "remaining": 7500,
    "effective_remaining": 7500,
    "supplier_id": null,
    "supplier_name": null,
    "label": "基础团款 ¥7,500.00（剩 ¥7,500.00）"
  },
  "historical_status": 200,
  "historical_content_type": "application/json"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 13；第 3–8 节的统一规则优先。

### 10.14. `POST /customer-payments`

页面/动作：提交审核。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "multipart/form-data",
  "body_fields": [
    "_token",
    "order_id",
    "order_item_id",
    "amount",
    "payment_method",
    "receipt_no",
    "bank_transaction_no",
    "receipt_files[]",
    "remark"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：payment_method 提交的是方式名称（如「微信」），不是字典 ID。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 14；第 3–8 节的统一规则优先。

### 10.15. `POST /supplier-payments`

页面/动作：提交审核。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "multipart/form-data",
  "body_fields": [
    "_token",
    "order_id",
    "order_item_id",
    "supplier_name",
    "supplier_contact",
    "supplier_phone",
    "amount",
    "payment_method",
    "invoice_no",
    "bank_transaction_no",
    "account_no",
    "remark",
    "invoice_files[]"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 15；第 3–8 节的统一规则优先。

### 10.16. `POST /review/customer-payments/{id}/approve`

页面/动作：财务角色点击通过（第 1 级）。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：按钮 data-action 暴露该 URL；通过后无独立「确认」步骤，最终审批后自动变为 已收款。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 16；第 3–8 节的统一规则优先。

### 10.17. `POST /review/supplier-payments/{id}/approve`

页面/动作：管理员通过（第 2 级）。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 17；第 3–8 节的统一规则优先。

### 10.18. `POST /orders/ai-parse`

页面/动作：粘贴聊天记录后点击「分析并填入表单」。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/json",
  "body_fields": [
    "raw_text"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 200；无原始响应体。

报文文件：[network_07_ai_parse.json](research/evidence/network_07_ai_parse.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "shape": "{success, data{customer_name,customer_phone,product_name,route_name,region_name,region_chain[],departure_city,departure_date,return_date,adult_count,child_count,total_amount,product_details,_customer_id,_route_id,_route_days,_route_city,_route_region_id}, fields{<字段名>: ok|required|suggested}, enriched{customer,supplier,route}}",
  "streaming": "历史样例为单次 JSON；一般流式能力未知",
  "side_effect": "服务端已创建客户与线路（实测 _customer_id/_route_id 对应记录真实存在）",
  "historical_status": 200,
  "historical_content_type": "application/json"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 18；第 3–8 节的统一规则优先。

### 10.19. `POST /users`

页面/动作：创建用户。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "application/x-www-form-urlencoded",
  "body_fields": [
    "_token",
    "name",
    "username",
    "email",
    "password",
    "phone",
    "role",
    "is_active"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_06_receipt_user.json](research/evidence/network_06_receipt_user.json)。

字段/行为备注：role 取值实测为 company_admin / operator / finance。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 19；第 3–8 节的统一规则优先。

### 10.20. `POST /users/{id}`

页面/动作：删除用户。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "_method=DELETE"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_08_cleanup.json](research/evidence/network_08_cleanup.json)。

字段/行为备注：删除未生效原因待确认（疑似存在关联业务记录）；已改停用处理。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 20；第 3–8 节的统一规则优先。

### 10.21. `GET /roles/{role_id}/permissions`

页面/动作：打开角色权限配置。

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 21；第 3–8 节的统一规则优先。

### 10.22. `POST /settings/company`

页面/动作：保存公司信息。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "content_type": "multipart/form-data",
  "body_fields": [
    "_token",
    "delete_logo",
    "company_name",
    "company_short",
    "company_phone",
    "company_address",
    "sidebar_theme",
    "app_font_size",
    "company_logo"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 22；第 3–8 节的统一规则优先。

### 10.23. `POST /settings/approval`

页面/动作：保存审批配置。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "receipt_role_0",
    "receipt_user_0",
    "receipt_role_1",
    "receipt_user_1",
    "receipt_executor_enabled",
    "receipt_executor_role",
    "payment_role_0",
    "payment_user_0",
    "payment_role_1",
    "payment_user_1",
    "payment_executor_enabled",
    "payment_executor_role",
    "undo_when_exec_disabled"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：当前配置：收款/付款均为 2 级，第 1 级 finance、第 2 级 company_admin，指定人为「任何人」。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 23；第 3–8 节的统一规则优先。

### 10.24. `POST /settings/order`

页面/动作：保存列设置与业务设置。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "columns[]",
    "column_order",
    "order_auto_complete",
    "commission_rate"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 24；第 3–8 节的统一规则优先。

### 10.25. `GET 页面路由集合`

路径：`/`、`/orders`、`/orders/create`、`/customer-payments`、`/supplier-payments`、`/supplier-payments/batch-settle`、`/account-balances`、`/review`、`/reports`、`/statistics`、`/leads`、`/leads/list`、`/regions`、`/suppliers`、`/routes`、`/customers`、`/audit-logs`、`/settings/company`、`/settings/operation`、`/settings/payment-methods`、`/settings/route-types`、`/settings/supplier-types`、`/settings/approval`、`/settings/departure-cities`、`/settings/customer-sources`、`/settings/order`、`/users`、`/users/create`、`/roles`。

页面/动作：页面导航。

存档核验：存在对应请求元数据；没有可用请求 postData；响应状态 200；无原始响应体。

报文文件：[network_01_login.json](research/evidence/network_01_login.json)、[network_02_nav_sweep.json](research/evidence/network_02_nav_sweep.json)、[network_03_supplier_create.json](research/evidence/network_03_supplier_create.json)、[network_04_master_data.json](research/evidence/network_04_master_data.json)、[network_06_receipt_user.json](research/evidence/network_06_receipt_user.json)、[network_08_cleanup.json](research/evidence/network_08_cleanup.json)、[network_10_regions.json](research/evidence/network_10_regions.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_content_type": "text/html; charset=utf-8"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 25；第 3–8 节的统一规则优先。

### 10.26. `GET /orders/calendar-data`

页面/动作：切换到日历视图。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "query": [
    "year",
    "month"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "shape": "{日期: {dep:[{id,order_no,name,product,amount,status}], ret:[...]}}  dep=出发、ret=回团",
  "sample_redacted": {
    "2026-10-20": {
      "dep": [
        {
          "id": 1070,
          "order_no": "ORD2026100200001",
          "name": "客户名",
          "product": "线路名",
          "amount": 4000,
          "status": "active"
        }
      ]
    }
  },
  "historical_status": 200,
  "historical_content_type": "application/json"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 26；第 3–8 节的统一规则优先。

### 10.27. `POST /orders/{id}`

页面/动作：保存编辑。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "_method=PUT",
    "其余同创建字段",
    "delete_contract_files",
    "contract_files[]"
  ]
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 200；无原始响应体。

报文文件：[network_07_ai_parse.json](research/evidence/network_07_ai_parse.json)、[network_08_cleanup.json](research/evidence/network_08_cleanup.json)。

字段/行为备注：回显金额为两位小数（2000.00）；customer_phone 回显为脱敏值 138****8004，直接保存会污染真实号码。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 27；第 3–8 节的统一规则优先。

### 10.28. `POST /orders/batch-reconcile`

页面/动作：勾选后点击确认对账。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token",
    "ids[]"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 28；第 3–8 节的统一规则优先。

### 10.29. `POST /orders/{id}/cancel`

页面/动作：取消订单。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 29；第 3–8 节的统一规则优先。

### 10.30. `POST /orders/{id}/recover`

页面/动作：恢复订单。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "body_fields": [
    "_token"
  ]
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 30；第 3–8 节的统一规则优先。

### 10.31. `GET /orders/export`

页面/动作：点击导出。

存档核验：存在对应请求元数据；没有可用请求 postData；响应状态 200；无原始响应体。

报文文件：[network_09_supplement.json](research/evidence/network_09_supplement.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_status": 200,
  "historical_content_type": "text/csv; charset=UTF-8",
  "historical_content_disposition": "attachment; filename=\"orders_YYYYMMDD_HHMMSS.csv\""
}
```

字段/行为备注：响应体为下载流，未被抓包工具保留；仅取得响应头。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 31；第 3–8 节的统一规则优先。

### 10.32. `GET /orders/trash`

页面/动作：打开回收站。

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：列：订单号/客户/产品/订单金额/原状态/创建人/删除时间；提示「恢复的订单将回到原来的状态，彻底删除后不可恢复」。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 32；第 3–8 节的统一规则优先。

### 10.33. `GET 页面路由集合`

路径：`/leads/pool`、`/leads/trash`、`/leads/settings`。

页面/动作：打开公海/回收站/设置。

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：公海列含原负责人；CRM 设置含公海超时天数与阶段管理（可标成交/放弃终态，第一个为默认阶段）。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 33；第 3–8 节的统一规则优先。

### 10.34. `GET /customers/tags`

页面/动作：打开标签管理。

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

字段/行为备注：editTagForm：name(必填)+color(radio)；保存接口未执行。

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 34；第 3–8 节的统一规则优先。

### 10.35. `POST /orders/{id}/confirm-booking`

页面/动作：预订单状态下点「确认出团」→ 二级确认弹窗「确认该订单已确定出团，转为进行中？」→ 点「确认」。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "request": {
    "content_type": "application/x-www-form-urlencoded（表单只需 _token）",
    "note": "触发点是 <form id=showConfirmBooking action=/orders/{id}/confirm-booking method=POST>，按钮 onclick=showConfirmModal(...)，回调里 document.getElementById('showConfirmBooking').submit()"
  }
}
```

存档核验：存在对应请求元数据；含请求 postData；响应状态 未入证；无原始响应体。

报文文件：[network_12_dict_preorder.json](research/evidence/network_12_dict_preorder.json)、[network_13_booking_confirm.json](research/evidence/network_13_booking_confirm.json)、[network_14_tourists.json](research/evidence/network_14_tourists.json)、[network_15_attachment.json](research/evidence/network_15_attachment.json)、[network_16_role_permission.json](research/evidence/network_16_role_permission.json)、[network_17_company_settings.json](research/evidence/network_17_company_settings.json)、[network_18_lead_stage.json](research/evidence/network_18_lead_stage.json)、[network_19_batch_settle.json](research/evidence/network_19_batch_settle.json)。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "effect": "订单状态 booking(预订单) → active(进行中)；详情页状态徽章同步变化",
  "historical_status": "未抓到（快照时响应未返回）"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 35；第 3–8 节的统一规则优先。

### 10.36. `POST /orders/{id}/tourists`

页面/动作：点「游客名单（0人）」openTouristModal() → 「添加游客」→ 逐行填 姓名/手机/证件类型/证件号/类型/年龄/性别/备注 → 点「保存」。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "request": {
    "note": "表格行内控件无 name，由 JS 收集成数组提交；必填校验：姓名*、证件号*；顶部有「人数不匹配」实时校验（成人差 N 人 / 儿童差 N 人）；证件类型枚举：身份证/护照/港澳通行证/台胞证"
  }
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "effect": "订单详情「游客名单」计数由 0人 → 3人",
  "historical_status": 200
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 36；第 3–8 节的统一规则优先。

### 10.37. `POST /review/customer-payments/{id}/reject`

页面/动作：直接 POST /review/customer-payments/{id}/reject（form_data: _token + reject_reason）。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "request": {
    "fields": [
      "_token",
      "reject_reason"
    ],
    "note": "前端入口为 paymentRejectModal，按钮只在有审核权限的角色 / 他人提交的申请上可见"
  }
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_status": 403,
  "result": "拒绝请求；驳回成功与路由全局存在性未证实，withdraw/undo 的 404 也不证明所有撤回能力不存在"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 37；第 3–8 节的统一规则优先。

### 10.38. `POST /roles/{role_id}/permissions`

页面/动作：点角色卡片「配置权限」→ 勾选/取消 60 个权限复选框 → 点「保存权限」。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "request": {
    "content_type": "application/x-www-form-urlencoded",
    "fields": [
      "permissions[] ×N（复选框 name 均为 permissions[]）",
      "全选 / 清空"
    ],
    "note": "实测流程：勾选一个未选权限 → 保存 → 计数 32→33 → 再取消并保存 → 回到 32（数据已还原，未残留变更）"
  }
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "historical_status": "302",
  "historical_location": "/roles"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 38；第 3–8 节的统一规则优先。

### 10.39. `POST /leads/{id}/follow-ups`

页面/动作：选「阶段」下拉（阶段不变/新线索/需求沟通/报价中/方案确认/已成单/已放弃）+ 填跟进内容 → 点「保存」。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "request": {
    "fields": [
      "stage",
      "content",
      "跟进类型（电话/微信/见面/邮件/其他，前端预置按钮）",
      "报价操作（新建/发送/客户接受/修改/删除）"
    ]
  }
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "effect": "线索列表阶段列 由「新线索」→「需求沟通」，跟进记录 +1",
  "historical_status": "302"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 39；第 3–8 节的统一规则优先。

### 10.40. `POST /supplier-payments/batch-settle`

页面/动作：勾选未付清订单行 → 填 付款日期* / 付款方式* / 备注 → 点「确认结算」→ 二级确认弹窗列明明细 → 再点「确认结算」。

请求参考（DOM 或历史记录，逐字段完整性需补测）：
```json
{
  "request": {
    "fields": [
      "orders[{id}][id]",
      "orders[{id}][supplier_id]",
      "orders[{id}][order_item_id]",
      "orders[{id}][amount]",
      "payment_date",
      "payment_method",
      "remark",
      "invoice_files[]"
    ],
    "note": "路径不是 /batch-settle；/batch-settle 只是导航菜单项，真实结算页为 /supplier-payments/batch-settle"
  }
}
```

存档核验：19 个网络文件中没有对应 method/path 请求；接口参考来自页面或执行文字。

历史结果/响应结构参考（不作为已核验 HTTP 响应）：
```json
{
  "effect": "实测：勾选 1 单（应付 ¥2,300.00）→ 本次付 ¥2,300.00 → 订单详情 已付款 ¥2,300.00 / 未付款 ¥0.00（付款进度 100%）",
  "historical_status": "302"
}
```

文字溯源：[旧接口记录](archive/research/ACTUAL_API_CATALOG.json)，条目 40；第 3–8 节的统一规则优先。


## 11. 逐功能覆盖与剩余范围

逐项对应旧清单的 41 项。以下描述执行到的具体场景；任何一项均不代表其标题列举的所有子功能已完成。旧顶层 blocked_before_login、历史汇总 21/15/4/1 和旧 network_captured 布尔值均停止使用。

### 11.1. AUTH — 登录、会话、当前租户、到期提示

依据范围：页面与执行记录；部分请求元数据。

登录及禁用拒绝已记录；会话过期/并发/退出/密码修改完整流程待测。

页面证据：[dashboard.json](research/evidence/pages/dashboard.json)。

### 11.2. HOME — 首页统计、待办、趋势、下钻

依据范围：页面/执行文字；按具体场景判断。

空态与有数据态均读取；下钻未逐项验证

页面证据：[dashboard.json](research/evidence/pages/dashboard.json)。

### 11.3. CUSTOMER — 客户列表、详情、创建、编辑、筛选、关联订单

依据范围：页面/执行文字；按具体场景判断。

创建成功并回读；空提交被服务端拒绝；删除成功

页面证据：[customers.json](research/evidence/pages/customers.json)。

### 11.4. TAG — 客户标签、标签关联

依据范围：页面/执行文字；按具体场景判断。

标签页与 editTagForm(name+color)已读；未创建标签

页面证据：[customer_tags.json](research/evidence/pages/customer_tags.json)。

### 11.5. SOURCE — 客户来源、来源层级

依据范围：页面/执行文字；按具体场景判断。

来源树 ID 1542-1585 已读取；层级维护未执行

页面证据：[orders_create.json](research/evidence/pages/orders_create.json)、[settings_customer_sources.json](research/evidence/pages/settings_customer_sources.json)。

### 11.6. LEAD — 线索列表、详情、创建、编辑、查重

依据范围：执行记录。

创建和回读、阶段跟进及批量软删除有记录；编辑/查重/转化待测。

页面证据：[leads_pool.json](research/evidence/pages/leads_pool.json)。

### 11.7. FOLLOWUP — 跟进、阶段、负责人、转客户与订单

依据范围：执行记录。

新线索→需求沟通及跟进有记录；其他阶段、负责人/分配、转客户/订单待测。

页面证据：未保存独立证据；仅有历史执行文字。

### 11.8. POOL — 公海认领、分配、回收

依据范围：页面/执行文字；按具体场景判断。

公海页与 CRM 设置（超时天数、阶段管理）已读；0 条线索，认领未执行

页面证据：[leads_pool.json](research/evidence/pages/leads_pool.json)、[leads_settings.json](research/evidence/pages/leads_settings.json)。

### 11.9. CRM_REPORT — CRM统计、漏斗、排行

依据范围：页面/执行文字；按具体场景判断。

CRM 仪表盘为空态；有数据后的漏斗/排行未回读

页面证据：[leads.json](research/evidence/pages/leads.json)。

### 11.10. SUPPLIER — 供应商列表、详情、创建、编辑、月结与非月结

依据范围：页面/执行文字；按具体场景判断。

创建并回读；删除被引用保护阻止（按钮 disabled）

页面证据：[suppliers.json](research/evidence/pages/suppliers.json)。

### 11.11. ROUTE — 线路列表、详情、创建、编辑、启用、自组团

依据范围：页面/执行文字；按具体场景判断。

创建并回读（含 AI 自动创建的线路 478）；两条均已删除

页面证据：[routes.json](research/evidence/pages/routes.json)。

### 11.12. REGION — 地区层级、创建、编辑、查重

依据范围：页面与部分请求元数据。

地区树及部分提交请求存在；后续文字称 CRUD 已跑通，但完整请求、结果和查重未成套留证。

页面证据：[orders_create.json](research/evidence/pages/orders_create.json)、[regions.json](research/evidence/pages/regions.json)。

### 11.13. DICT — 付款方式、线路类型、供应商类型、出发城市

依据范围：页面与执行文字。

字典枚举存在；后续文字称 CRUD 已执行，所有类别增删改未有完整证据链。

页面证据：[settings_departure_cities.json](research/evidence/pages/settings_departure_cities.json)、[settings_payment_methods.json](research/evidence/pages/settings_payment_methods.json)、[settings_route_types.json](research/evidence/pages/settings_route_types.json)、[settings_supplier_types.json](research/evidence/pages/settings_supplier_types.json)。

### 11.14. ORDER_CREATE — 正式/预订单、客户/线路/供应商快捷新增

依据范围：页面与执行记录；新建请求元数据。

正式/预订单创建有记录；order_type=active|booking 按后续执行记录；快捷新增三弹窗独立提交待测。

页面证据：[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)、[orders_create.json](research/evidence/pages/orders_create.json)。

### 11.15. ORDER_READ — 订单列表、详情、编辑、筛选、排序、分页

依据范围：页面与执行记录。

列表/详情/编辑 DOM 已保存，附件编辑保存有记录；筛选/排序/分页全部组合待测，掩码覆盖风险未独立复现。

页面证据：[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)、[order_edit_1070.json](research/evidence/pages/order_edit_1070.json)、[orders.json](research/evidence/pages/orders.json)。

### 11.16. ORDER_PRICE — 成人儿童人数单价、总价覆盖、动态应收应付、利润

依据范围：页面与执行记录。

人数/单价/利润样例及计算式展示；总价覆盖与动态明细异常、服务端篡改金额重算待测。

页面证据：[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)、[reports_with_data.json](research/evidence/pages/reports_with_data.json)。

### 11.17. ORDER_CALENDAR — 日历、年份月份、筛选

依据范围：页面/执行文字；按具体场景判断。

日历接口 `GET /orders/calendar-data?year=&month=` 有历史结构摘录：{日期:{dep:[…],ret:[…]}}；请求匹配与响应元数据见第 10.26 节，完整响应体未存档，年份月份/筛选组合待测。

页面证据：未保存独立证据；仅有历史执行文字。

### 11.18. ORDER_BATCH — 批量操作、取消、恢复

依据范围：执行记录；部分请求元数据。

批量软删除、对账、取消/恢复有执行记录；批量锁团与取消对账待测。

页面证据：未保存独立证据；仅有历史执行文字。

### 11.19. ORDER_LOCK — 锁团、解锁、原因、编辑限制

依据范围：页面/执行文字；按具体场景判断。

锁团、填原因解锁和编辑入口受限有执行记录；服务端绕过编辑及并发状态转换待测。

页面证据：[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)。

### 11.20. RECONCILE — 对账、取消对账、供应商关联

依据范围：页面/执行文字；按具体场景判断。

确认对账已执行：`POST /orders/batch-reconcile`，提示仅做标记不影响数据；取消对账未执行

页面证据：未保存独立证据；仅有历史执行文字。

### 11.21. RECEIPT — 收款申请、项目联动、详情、编辑、部分收款

依据范围：页面/执行文字；按具体场景判断。

部分收款 3000/7500 已提交、审批、确认并回读

页面证据：[customer_payments_after.json](research/evidence/pages/customer_payments_after.json)、[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)、[receipt_create.json](research/evidence/pages/receipt_create.json)。

### 11.22. PAYMENT — 付款申请、项目及供应商联动、详情、编辑

依据范围：页面/执行文字；按具体场景判断。

全额付款 4800 已提交、审批、确认并回读；供应商联系人电话自动带出

页面证据：[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)、[payment_create.json](research/evidence/pages/payment_create.json)。

### 11.23. APPROVAL — 逐级审批、驳回、重提、撤回、自审条件

依据范围：执行记录；完整驳回链待测。

两级通过后自动确认有记录；驳回请求被拒，不算成功；自审/撤回/重提/并发需独立验证。

页面证据：未保存独立证据；仅有历史执行文字。

### 11.24. CONFIRM — 内部确认收付款、余额变化、禁止真实转账

依据范围：执行记录。

最终审批自动确认内部收付；关闭自动确认后的手工流程待测；预订单确认出团见第 3.1 节。

页面证据：[order_detail_1069.json](research/evidence/pages/order_detail_1069.json)。

### 11.25. SETTLEMENT — 批量结算、重复纳入、月结

依据范围：执行记录。

单个应付 2300 付清和二次确认有记录；重复纳入、月结及审批路径待测。

页面证据：[batch_settle.json](research/evidence/pages/batch_settle.json)。

### 11.26. BALANCE — 账户余额、期初、刷新与对账

依据范围：页面/执行文字；按具体场景判断。

按付款方式分账户，期初/收/付/余额已回读

页面证据：[balances_with_data.json](research/evidence/pages/balances_with_data.json)。

### 11.27. REPORT — 经营总览、订单明细、供应商统计、口径

依据范围：页面/执行文字；按具体场景判断。

经营总览/订单明细/供应商统计与口径说明已回读；下钻未逐项验证

页面证据：[reports_with_data.json](research/evidence/pages/reports_with_data.json)。

### 11.28. PERFORMANCE — 业绩、自己/全部、员工归属

依据范围：页面/执行文字；按具体场景判断。

创建人贡献、线路表现、亏损提醒已回读

页面证据：[statistics_with_data.json](research/evidence/pages/statistics_with_data.json)。

### 11.29. IMPORT — 导入、模板、失败明细

依据范围：入口未完整确认。

没有完整导入流程证据；部分弹窗有导入/模板文案，需定位实际能力。

页面证据：未保存独立证据；仅有历史执行文字。

### 11.30. EXPORT — 导出、格式、文件内容、访问控制

依据范围：执行记录。

CSV 下载及文件名/响应头文字记录；导出内容与权限过滤待测。

页面证据：未保存独立证据；仅有历史执行文字。

### 11.31. ATTACHMENT — 上传、预览、下载、20MB文案、访问控制

依据范围：页面与执行记录。

订单合同上传 0→1 有记录；收付款凭证、下载/预览/大小限制及鉴权待测。

页面证据：[orders_create.json](research/evidence/pages/orders_create.json)。

### 11.32. USER — 用户列表、详情、编辑、启停、角色关联

依据范围：页面/执行文字；按具体场景判断。

创建财务用户成功；停用已生效（登录被拒）；删除未生效

页面证据：[users.json](research/evidence/pages/users.json)、[users_create.json](research/evidence/pages/users_create.json)。

### 11.33. ROLE — 角色、60项权限文案、own/all作用域

依据范围：页面与执行记录。

60 项页面与权限保存计数变化有记录；完整角色矩阵、own/all 服务端范围待测。

页面证据：[roles.json](research/evidence/pages/roles.json)。

### 11.34. COMPANY — 公司资料、主题、字号、Logo、存储配额

依据范围：页面与执行记录。

侧栏主题持久化并还原有记录；Logo/字号/全部资料与配额限制待测。

页面证据：[settings_company.json](research/evidence/pages/settings_company.json)。

### 11.35. APPROVAL_SETTING — 审批配置、多级角色、自动确认、撤回开关

依据范围：页面/执行文字；按具体场景判断。

两级角色、执行人、撤回开关已读取；保存未执行

页面证据：[settings_approval.json](research/evidence/pages/settings_approval.json)。

### 11.36. ORDER_SETTING — 订单管理设置与条件字段

依据范围：页面/执行文字；按具体场景判断。

列设置、自动锁团、提成率已读取；保存未执行

页面证据：[settings_order.json](research/evidence/pages/settings_order.json)。

### 11.37. SECURITY_LOG — 操作安全、操作日志、历史与审计

依据范围：页面/执行文字；按具体场景判断。

19 条日志已读取，含审批与锁团动作

页面证据：[audit_logs_with_data.json](research/evidence/pages/audit_logs_with_data.json)。

### 11.38. RECYCLE — 回收站、恢复、关联校验、删除策略

依据范围：页面与执行记录。

订单移入回收站、引用保留有记录；恢复/物理删除与完整级联待测。

页面证据：[leads_trash.json](research/evidence/pages/leads_trash.json)、[orders_trash.json](research/evidence/pages/orders_trash.json)。

### 11.39. AI_PARSE — 虚构文本→解析→填充→人工调整→保存回读

依据范围：页面/执行文字；按具体场景判断。

解析成功并返字段；副作用：自动创建客户与线路；未保存订单

页面证据：未保存独立证据；仅有历史执行文字。

### 11.40. AI_CRM — AI工作建议、非空线索下的返回

依据范围：页面/执行文字；按具体场景判断。

AI 工作建议为空态文案「当前所有线索跟进正常」

页面证据：[leads.json](research/evidence/pages/leads.json)。

### 11.41. TENANT_SCOPE — 租户身份、同租户对象权限、附件导出授权

依据范围：页面；隔离未验证。

仅一个租户；跨租户与同租户本人/全部、文件/导出数据范围未验证。

页面证据：[roles.json](research/evidence/pages/roles.json)、[users.json](research/evidence/pages/users.json)。


## 12. 证据索引与历史来源

文件实点：43 份页面 JSON、19 份网络 JSON；网络共 2902 条快照记录，885 个不同 requestId，77 个不同 method/URL 组合。requestId 在不同采集场景可能复用，单独去重不能直接称为独立业务请求数；同一 confirm-booking 请求也在多份文件重复出现。

历史 19 份报文支持重定向前的请求、部分响应元数据，未存完整响应体。目录中的 JSON shape 和样例保留为历史摘录；后续独立详情文件另按其实际内容判断。

### 12.1. 网络文件

- [network_01_login.json](research/evidence/network_01_login.json)：33 条快照记录。

- [network_02_nav_sweep.json](research/evidence/network_02_nav_sweep.json)：240 条快照记录。

- [network_03_supplier_create.json](research/evidence/network_03_supplier_create.json)：14 条快照记录。

- [network_04_master_data.json](research/evidence/network_04_master_data.json)：41 条快照记录。

- [network_05_order_create.json](research/evidence/network_05_order_create.json)：11 条快照记录。

- [network_06_receipt_user.json](research/evidence/network_06_receipt_user.json)：11 条快照记录。

- [network_07_ai_parse.json](research/evidence/network_07_ai_parse.json)：2 条快照记录。

- [network_08_cleanup.json](research/evidence/network_08_cleanup.json)：234 条快照记录。

- [network_09_supplement.json](research/evidence/network_09_supplement.json)：2 条快照记录。

- [network_10_regions.json](research/evidence/network_10_regions.json)：26 条快照记录。

- [network_11_paymethod_notif.json](research/evidence/network_11_paymethod_notif.json)：11 条快照记录。

- [network_12_dict_preorder.json](research/evidence/network_12_dict_preorder.json)：11 条快照记录。

- [network_13_booking_confirm.json](research/evidence/network_13_booking_confirm.json)：314 条快照记录。

- [network_14_tourists.json](research/evidence/network_14_tourists.json)：320 条快照记录。

- [network_15_attachment.json](research/evidence/network_15_attachment.json)：322 条快照记录。

- [network_16_role_permission.json](research/evidence/network_16_role_permission.json)：325 条快照记录。

- [network_17_company_settings.json](research/evidence/network_17_company_settings.json)：326 条快照记录。

- [network_18_lead_stage.json](research/evidence/network_18_lead_stage.json)：328 条快照记录。

- [network_19_batch_settle.json](research/evidence/network_19_batch_settle.json)：331 条快照记录。


### 12.2. 页面文件

- [account_balances.json](research/evidence/pages/account_balances.json)：`/account-balances`。

- [audit_logs.json](research/evidence/pages/audit_logs.json)：`/audit-logs`。

- [audit_logs_with_data.json](research/evidence/pages/audit_logs_with_data.json)：`/audit-logs`。

- [balances_with_data.json](research/evidence/pages/balances_with_data.json)：`/account-balances`。

- [batch_settle.json](research/evidence/pages/batch_settle.json)：`/supplier-payments/batch-settle`。

- [customer_payments.json](research/evidence/pages/customer_payments.json)：`/customer-payments`。

- [customer_payments_after.json](research/evidence/pages/customer_payments_after.json)：`/customer-payments`。

- [customer_tags.json](research/evidence/pages/customer_tags.json)：`/customers/tags`。

- [customers.json](research/evidence/pages/customers.json)：`/customers`。

- [dashboard.json](research/evidence/pages/dashboard.json)：`/`。

- [leads.json](research/evidence/pages/leads.json)：`/leads`。

- [leads_pool.json](research/evidence/pages/leads_pool.json)：`/leads/pool`。

- [leads_settings.json](research/evidence/pages/leads_settings.json)：`/leads/settings`。

- [leads_trash.json](research/evidence/pages/leads_trash.json)：`/leads/trash`。

- [order_detail_1069.json](research/evidence/pages/order_detail_1069.json)：`/orders/1069`。

- [order_edit_1070.json](research/evidence/pages/order_edit_1070.json)：`/orders/1070/edit`。

- [orders.json](research/evidence/pages/orders.json)：`/orders`。

- [orders_create.json](research/evidence/pages/orders_create.json)：`/orders/create`。

- [orders_trash.json](research/evidence/pages/orders_trash.json)：`/orders/trash`。

- [payment_create.json](research/evidence/pages/payment_create.json)：`/supplier-payments/create`。

- [receipt_create.json](research/evidence/pages/receipt_create.json)：`/customer-payments/create`。

- [regions.json](research/evidence/pages/regions.json)：`/regions`。

- [reports.json](research/evidence/pages/reports.json)：`/reports`。

- [reports_with_data.json](research/evidence/pages/reports_with_data.json)：`/reports`。

- [review.json](research/evidence/pages/review.json)：`/review`。

- [review_after_submit.json](research/evidence/pages/review_after_submit.json)：`/review`。

- [roles.json](research/evidence/pages/roles.json)：`/roles`。

- [routes.json](research/evidence/pages/routes.json)：`/routes`。

- [settings_approval.json](research/evidence/pages/settings_approval.json)：`/settings/approval`。

- [settings_company.json](research/evidence/pages/settings_company.json)：`/settings/company`。

- [settings_customer_sources.json](research/evidence/pages/settings_customer_sources.json)：`/settings/customer-sources`。

- [settings_departure_cities.json](research/evidence/pages/settings_departure_cities.json)：`/settings/departure-cities`。

- [settings_operation.json](research/evidence/pages/settings_operation.json)：`/settings/operation`。

- [settings_order.json](research/evidence/pages/settings_order.json)：`/settings/order`。

- [settings_payment_methods.json](research/evidence/pages/settings_payment_methods.json)：`/settings/payment-methods`。

- [settings_route_types.json](research/evidence/pages/settings_route_types.json)：`/settings/route-types`。

- [settings_supplier_types.json](research/evidence/pages/settings_supplier_types.json)：`/settings/supplier-types`。

- [statistics.json](research/evidence/pages/statistics.json)：`/statistics`。

- [statistics_with_data.json](research/evidence/pages/statistics_with_data.json)：`/statistics`。

- [supplier_payments.json](research/evidence/pages/supplier_payments.json)：`/supplier-payments`。

- [suppliers.json](research/evidence/pages/suppliers.json)：`/suppliers`。

- [users.json](research/evidence/pages/users.json)：`/users`。

- [users_create.json](research/evidence/pages/users_create.json)：`/users/create`。


### 12.3. 历史文字来源


- [当前详细需求](REQUIREMENTS.md)：页面范围及后续执行校正。

- [原始证据目录](research/evidence/)：数字样例、逐级审批、AI 写副作用及清理回读。

- 本规格第 14 节及原始证据目录：预订单、游客、附件、角色、主题、跟进、结算执行文字。

- [原接口目录](archive/research/ACTUAL_API_CATALOG.json)、[原覆盖清单](archive/research/FUNCTION_COVERAGE.json)：仅供查找原始表述；其状态标记与推断已由本文替代。

- 本规格第 1 节的证据口径与维护规则：旧调研及 ERP 开发材料的身份。


## 13. 测试租户清理记录与后续维护

历史第四轮回读记录：订单 1071/1072、客户 816、线路 480、线索 254 和相关收付款已不在活动列表；角色权限还原 32/60、公司主题还原 dark。列表为空不代表物理删除、关联财务级联清除或附件释放。

本轮标签已删除；订单 1073 已从回收站恢复为进行中；收款 1155 和付款 1047 在终审撤回后均被驳回，已确认金额为 0。新建财务测试用户 91 的删除流程将其变为禁用并清空角色，保留记录供审计。客户、线路、供应商和订单仍作为一组虚构复刻样本保留，避免不可逆清理破坏证据。历史供应商 387 仍因引用受保护。

> 2026-11-20 用户已明确：目标站仅供复刻参考，**不再登录、不再清理其中任何数据**
> （含供应商 387、测试用户 90）。以上仅为当轮调研的历史事实记录，不是待办。

新增证据按原脱敏规则保存到 `research/evidence/`，在本文件更新具体条目、证据链接及剩余范围；涉及产品行为改动时先明确是复刻事实还是新设计决定。历史归档 Markdown 已清理；后续只更新本规格和原始证据目录。

## 14. agent-browser 补测进度（2026-10-02）

使用已安装的 `agent-browser` CLI 0.27.0，在独立管理员、财务和未登录会话中完成补测。所有工作区证据先经过 `research/scripts/sanitize_evidence.py` 脱敏；Cookie、Authorization、CSRF、密码、手机号、邮箱、证件号、IP 及长令牌不进入文档证据。

### 14.1 已确认链路

- **登录**：真实 `POST /login` 后进入仪表盘；登录表单、请求和认证后页面均已保存。登录接口已抓取。
- **基础资料**：客户标签新建、修改、删除；订单内快捷新增客户、线路、供应商，三个接口均返回 200 并回填选择项。
- **订单**：新建订单 1073（`booking`）、确认出团、进行中转预订单、再次确认出团、锁团、填写原因解锁均成功。动态应收 1,100、应付 650、利润 450 回读一致。
- **游客**：手工新增与 CSV 导入成功；模板、字段、追加模式、人数不匹配仅警告均已确认。
- **附件**：合同、收款凭证、付款凭证 PDF 上传成功；本轮合同在认证会话可下载，未登录会话被要求登录。
- **财务**：具体应收项目超额收款被服务端拒绝；收款 300、付款 200 均跑通财务 → 管理员两级审批及自动确认。收款跑通驳回、编辑回复、重提。两类终审均跑通 `undo-approve`，状态回到管理员待审且确认金额回滚；最后将两条测试申请驳回，避免保留已确认余额。
- **权限事实**：管理员可终审自己创建的申请，当前配置没有通用禁自审；财务账号只能处理财务级待办。更细的本人/全部权限仍需专门样本。
- **订单辅助**：CSV 导出返回 UTF-8 CSV，包含订单、客户掩码、线路、人数、金额、收付笔数、利润、创建人和时间等 31 列。确认对账和取消对账均成功。批量删除将订单移入回收站。

### 14.2 缺陷和未完成边界

- CRM 新建线索首次缺必填字段时返回字段级错误；补全目的地、出游类型和日期后，`POST /leads` 返回 HTTP 500，回查列表无新增。因此跟进、公海、转客户/订单没有可用前置数据，不能标为通过。
- 回收站恢复表单带 `data-checkpoint=order.restore`，经两次页面确认后订单 1073 成功恢复到进行中；该次未出现密码输入框。彻底删除未执行。
- 第二租户、同租户不同业务人员、文件对象级授权、导出按角色过滤、配置变化中的在途审批、关闭自动确认、并发/重复提交、退款冲正、畸形 CSV 和 20MB 服务端限制仍未验证。
- 本轮创建的财务测试用户已通过删除流程变为禁用并移除角色；业务样本保留，见第 13 节。
- 通知面板已读取并看到 3 条待办，外部消息投递未测试；系统没有证据表明存在真实银行转账或外部通知，本轮也未触发任何真实外部动作。

### 14.3 本轮主要证据

- 登录与工作台：`research/evidence/recheck_20261002_01_login.json`、`research/evidence/pages/recheck_20261002_dashboard.json`。
- 标签与快捷新增：`recheck_20261002_03_tag_create.json` 至 `08_quick_supplier.json`。
- 订单与游客：`10_order_actual_submit.json`、`11_confirm_booking.json`、`15_tourist_csv_import.json`、`32_to_booking.json`、`33_reconfirm_lock.json`、`34_unlock.json`。
- 附件与额度：`12_attachment_authenticated.json`、`13_attachment_guest.json`、`17_receipt_over_limit_actual.json`、`18_receipt_with_file.json`、`19_partial_payment_file.json`。
- 审批闭环：`22_receipt_reject.json` 至 `31_payment_final_reject.json`。
- CRM 错误、导出、对账和回收站：`37_lead_full_fields.json` 至 `43_order_restore_confirm.json`；对应页面回读在 `research/evidence/pages/`。

证据文件名里的序号表示本轮采集顺序，不是产品接口版本。重定向式表单提交在 DevTools 详情中可能没有独立状态码，结论同时依据请求正文、最终页面和业务回读，不能仅凭 `status=null` 判断失败。
