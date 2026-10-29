# 运营后台后端契约与运营数据域规格

| 项目 | 值 |
| --- | --- |
| 契约版本 | `1.0.0`（ops-v1 首个冻结候选） |
| 文档状态 | 已定稿，待实现（后端实现前不得删改字段语义） |
| 编写日期 | 2026-10-29 |
| 数据真源 | `udone/supabase/migrations/`（本文件不产生任何迁移，仅约束其内容） |
| API 真源 | `udone/packages/contracts/src/ops/**`（实现时创建）+ `udone/apps/api/src/modules/ops/**` |
| 消费方 | `ERP-ops/admin/apps/web-antd`（只消费 `/api/v1/ops/*`，禁止直连数据库） |
| 需求真源 | `admin/Docs/PRD.md`（下称 PRD）、`admin/ARCHITECTURE.md`、`admin/.harness/API_STANDARDS.md`、`admin/.harness/DATABASE_STANDARDS.md` |
| 实现约束继承 | `udone/.harness/CONTRACTS.md`、`udone/.harness/API_STANDARDS.md`、`udone/.harness/DATABASE_STANDARDS.md` |

**标注约定**

- 每个字段、状态、动作、端点都带来源：`[PRD §6.4]` 表示 PRD 明文；`[推导]` 表示 PRD 未明确、由本文件决策并给出默认值，同时在第 11 章登记为待产品确认项。
- `[继承]` 表示来自 `udone` 既有实现或 `.harness` 规范（可验证的仓库事实），不是 PRD 需求。
- 本文件不写 TypeScript 实现代码，只写表、列、状态、路径、错误码、权限与验收断言。

---

## 1. 范围与边界声明

### 1.1 ops 域拥有什么

ops 域只持久化「软件提供方与旅行社之间的商业关系、交付台账与内部协作」，共 9 个领域 [PRD §9.1] [PRD §10.4]：

| 领域 | 拥有的事实 | 来源 |
| --- | --- | --- |
| `customer` | 软件客户档案、联系人、负责人、客户生命周期 | [PRD §6.2] |
| `catalog` | 产品、销售方式开放项、套餐、价格版本、功能键、套餐权益定义 | [PRD §6.3] |
| `contract` | 合同、合同条目、合同版本快照、变更单、续约关联、合同附件引用 | [PRD §6.4] |
| `billing` | 应收计划、展期记录、收款登记、核销分配、核销撤销、退款登记 | [PRD §6.5] |
| `entitlement` | SaaS 订阅、私有化授权、权益快照与快照行、权益变更申请 | [PRD §6.6] |
| `tenant-integration` | 租户映射、跨系统命令、命令尝试记录、同步版本与失败分类 | [PRD §6.7] |
| `deployment` | 私有化部署实例、版本升级记录 | [PRD §6.8] |
| `support` | 售后工单、不可覆盖时间线、工单与命令/变更/升级的关联 | [PRD §6.9] |
| `identity-audit` | 运营成员、角色、权限目录、角色授权、审计事件、幂等记录、字典、系统设置、导出任务 | [PRD §4] [PRD §6.10] |

### 1.2 ops 域明确不管什么

| 排除项 | 说明 | 来源 |
| --- | --- | --- |
| 线索、获客、营销、销售漏斗、CRM、自动化邮件 | 客户档案从「已签约或明确进入交付」开始，不做线索漏斗 | [PRD §2.3] [PRD §2.4] |
| 客户自助门户、客户自助下单/续费 | 仅内部员工使用，无公开注册 | [PRD §2.1] [PRD §4.1] |
| 在线支付、银行自动对账、自动开票、电子发票平台 | 收款与退款均为线下事实登记，不调用支付渠道 | [PRD §2.4] [PRD §6.5] |
| 电子合同签署、合同模板签署流、法律意见 | 附件只存引用和元数据 | [PRD §2.4] [PRD §6.4] |
| 私有化自动部署、远程升级、SSH/root 凭据、远程命令执行、安装包托管 | 升级记录只登记「已执行的结果」 | [PRD §2.4] [PRD §6.8] |
| 旅行社业务：订单、游客、应收应付、审批、余额、租户内部用户 | 由 `udone` 独占，ops 只保存外部 ID 与状态摘要 | [PRD §2.2] [PRD §9.1] |
| AI 客服、智能体对话、呼叫中心、自动 SLA、外部通知 | 工单只做内部时限提示 | [PRD §2.4] [PRD §6.9] |
| 多币种换算、跨境结算、汇率合并统计 | 同一合同链路单一币种，统计按币种分组不合并 | [PRD §2.4] [PRD §6.4] |
| 旅行社员工权限体系复用 | 运营成员关系与旅行社成员关系是两套授权域 | [PRD §4.1] [PRD §6.10] |

### 1.3 强制边界（违反即为契约缺陷）

1. ops 后端代码只允许落在 `udone/apps/api/src/modules/ops/**`、`udone/packages/contracts/src/ops/**`、`udone/supabase/migrations/**`；`admin` 侧只消费契约 [继承 `admin/ARCHITECTURE.md`]。
2. ops 表一律位于 `ops` schema，**不得**在 `public` schema 下新增运营业务表，也不得与 `public` 表建立跨 schema 外键（见 §2.7）。
3. ops 路由不得出现在 `/api/*` 未版本化命名空间；旅行社既有路由不得因 ops 改造而变更 [PRD §9.3]。
4. 任何 ops 端点都必须先过「身份 → 运营成员状态 → 权限动作 → 输入校验 → 业务规则」，顺序不可调换 [PRD §9.3]。
5. 角色名不参与任何服务端分支判断，只以权限动作判定 [PRD §4.2]。

---

## 2. 契约总则

### 2.1 API 版本前缀决策

**决策：ops 使用 `/api/v1/ops` 作为独立版本化命名空间；旅行社既有 API 保持无版本前缀的 `/api/*` 不变。**

| 事项 | 结论 | 理由 |
| --- | --- | --- |
| ops 前缀 | `/api/v1/ops/...` | PRD 明确「运营接口位于独立版本化命名空间（建议 `/api/v1/ops/*`）」[PRD §9.3]；ops 是全新契约，无历史包袱 |
| 既有 `/api/*` | 不动、不重命名、不加 `/v1` | `udone/.harness/CONTRACTS.md` §12 记录「当前没有 `/api/v1` 版本前缀」[继承]；把既有路由改写会破坏另一并行会话的工作 [继承 `admin/.harness/docs/exec-plans/...parallel-development-handoff.md`] |
| 版本号语义 | v1 内只允许**加法**兼容（新增端点、新增可选响应字段、新增枚举值的向后兼容处理见 §2.6） | 版本化目的不是装饰，而是给前端一个稳定消费面 |
| 破坏性变更 | 新开 `/api/v2/ops`，v1 保留至少一个发布周期 | 与 udone 迁移不可回改的原则一致 [继承 `DATABASE_STANDARDS.md`] |
| 端点自述 | `GET /api/v1/ops/meta` 返回 `contractVersion`、`serverTime`、`timezone`、`supportedSalesModes`、`supportedCurrencies` | 前端据 `contractVersion` 做不兼容快速失败，禁止静默回退 mock |

> ⚠️ 该决策使仓库同时存在两种前缀形态。控制手段：所有 ops 路径字符串必须写在 `ROUTES`/`OPS_ROUTES` 契约清单里并由 `route-parity.test.ts` 对账，禁止在 handler 中手写路径 [继承 `udone/packages/contracts/src/routes.ts` 注释与 `apps/api/src/contracts/route-parity.test.ts`]。

### 2.2 金额与精度决策

**决策：数据库 `numeric(14,2)`（精确十进制），JSON 传输 `number`（最多 2 位小数），服务端不做浮点累加。**

| 结论 | 内容 | 理由 |
| --- | --- | --- |
| 存储类型 | `numeric(14,2)`，与 `udone` 现有 `order_receivables.amount numeric(14,2)` 完全一致 [继承 `20261029000002_order_domain.sql`] | PRD §10.3 明文要求「金额使用精确十进制类型，禁止浮点金额计算」——整数分是整数类型，不符合该条文字；且两套 API 出现两种金额表示会立刻产生换算缺陷 |
| 取值范围 | 12 位整数 + 2 位小数（上限 999,999,999,999.99） | 单个合同/应收/收款记录不可能超过该量级；跨记录合计在 SQL 聚合中不受列精度限制 |
| JSON 表示 | `number`，服务端 `round(…, 2)` 后输出，禁止字符串 | `udone/.harness/CONTRACTS.md` §4 已裁定「金额 = number（精确到分）并注明币种，禁止字符串混用」[继承] |
| 计算位置 | 所有合计、余额、核销上限、指标均由 SQL `numeric` 聚合或 RPC 计算；JavaScript **只格式化不累加** | PRD §10.3「服务端根据明细复算总额」[PRD §10.3]；同时避免 `0.1+0.2` 类误差进入总览口径 |
| 客户端合计 | API 不接受客户端提交的合计/差额字段；请求体只接受明细行金额 | [PRD §10.3] [推导] |
| 币种 | `currency char(3)`，ISO-4217，默认 `CNY`；同一合同链路（合同→条目→应收→收款→核销→退款）币种必须一致，由复合外键强制 | [PRD §6.4] 单份合同单币种；[推导] 允许非 CNY 记账但总览按币种分组、不合并 [PRD §2.4] |
| 已拒绝方案 | 整数分（`bigint` cents） | 与既有 `numeric(14,2)` 及 CONTRACTS.md 金额 `number` 冲突；全链路 ×100/÷100 会引入新的换算层；导出与 SQL 报表需额外转换，得不偿失 |

**精度保护三件套（必须同时实现）**

1. 数据库列 `numeric(14,2)` + `CHECK (amount >= 0)`（退款/冲正用独立正数流水 + 方向字段，不用负数列值）。
2. 请求体 zod 校验：`z.number().multipleOf(0.01)` 且 `>= 0`，最大值 `999999999999.99`。
3. 出站 `respond()` 前统一 `roundTo2`，并断言 `Number.isSafeInteger(Math.round(v * 100))`。

### 2.3 时间与日期

| 类型 | 约定 | 来源 |
| --- | --- | --- |
| 时间戳 | `timestamptz`，JSON 为 ISO 8601 UTC（`2026-10-29T02:00:00Z`） | [继承 CONTRACTS.md §4] |
| 纯日期 | `date`，JSON 为 `YYYY-MM-DD`（签约日、生效日、到期日、计划收款日、上线日、维护到期日） | [PRD §6.4] [PRD §6.5] |
| 「今天」 | 一律用**运营端业务时区 `Asia/Shanghai`** 的当前日期参与应收逾期、临期权益、工单超期计算 | [推导] 服务器 UTC 直接比较会在 00:00–08:00 产生一天的偏差 |
| 统计口径披露 | 总览/报表响应必须携带 `statisticsAt`（统计时刻）、`windowDays`（到期窗口）、`currency` 分组 | [PRD §6.1] [PRD §12] |

### 2.4 响应与错误形态

| 场景 | 形态 | 来源 |
| --- | --- | --- |
| 成功（资源） | 直接返回裸资源体，如 `{ "customer": {...} }`，不套 `success/data` | [继承 CONTRACTS.md §3.8] |
| 成功（列表） | `{ items, total, page, pageSize }`，`total` 为满足筛选条件的总数 | [继承 `pagination.ts`] |
| 失败 | `{ code, message, requestId, details? }`，含 `X-Request-Id` 响应头 | [继承 `error-handler.ts`] |
| 分页 | 复用 `listQuerySchema`：`page` 默认 1、`pageSize` 白名单 `10/15/20/30/50/100`、默认 15、`sort` 白名单、`order` 默认 desc | [继承 `pagination.ts`]；PRD 要求默认 ≤ 50 行 [PRD §10.1] |
| 校验失败 | 400 `VALIDATION_ERROR`，`details.issues` 只含 `path` 与 `code`，不回显用户原值 | [继承 CONTRACTS.md §6] |
| 异步命令 | 202 + `{ commandId, status, idempotencyKey }`，客户端轮询 `GET .../commands/{id}` | [PRD §6.7] [PRD §9.3] |

### 2.5 幂等

| 规则 | 内容 | 来源 |
| --- | --- | --- |
| Header | 写请求携带 `Idempotency-Key`（8–128 字符 `[A-Za-z0-9_-]`），格式与既有中间件一致 | [继承 `middleware/idempotency.ts`] |
| 必填范围 | 合同生效/终止、应收生成/展期、收款登记/审核/核销/核销撤销/退款、权益变更、租户命令、部署升级记录、导出创建 —— **必填**；其余写操作**可选** | [PRD §6.7] [PRD §10.3] [推导 必填范围] |
| 存储 | `ops.idempotency_records`（数据库，不是进程内存） | 现有 `createMemoryIdempotencyStore` 是 isolate 内缓存，跨 Worker 实例不生效，无法保护钱款与开通命令 [继承 `lib/idempotency-store.ts` 注释] |
| 语义 | 同 key 同 `requestHash` → 返回首次 2xx 响应体 + `Idempotent-Replay: true`；同 key 不同 `requestHash` → 409 `IDEMPOTENCY_CONFLICT`；只在 2xx 落库 | [继承 `middleware/idempotency.ts`] |
| 跨系统命令 | 双重幂等：HTTP `Idempotency-Key` + 命令表 `idempotency_key UNIQUE`，重试复用同一个 key | [PRD §6.7] |

### 2.6 枚举与兼容

- 所有状态列用 `text + CHECK`（不用 PG `enum` 类型），与 `udone` 现有迁移风格一致 [继承]。
- 新增枚举值必须同时出现在：迁移 CHECK、`packages/contracts` 的 `z.enum`、本文件状态表；三者不一致视为缺陷。
- 前端遇未知枚举值必须降级显示 `未知(<raw>)` 而不是空白，避免后端加法变更导致渲染崩溃 [推导]。

### 2.7 与租户数据的边界（硬规则）

| 规则 | 内容 | 来源 |
| --- | --- | --- |
| 只存引用 | ops 只保存 `udone_organization_id uuid`、`external_ref text`、`last_known_state`、`last_synced_at`、`sync_version` | [PRD §6.7] [PRD §9.1] |
| 禁止跨 schema 外键 | `ops.tenant_mappings.udone_organization_id` **不建** 到 `public.organizations(id)` 的外键 | [推导] 外键会把两套迁移顺序绑死，并让跨域 join 变得"顺手"；存在性在命令下发时由 `udone` 内部接口确认 |
| 禁止复制 | 不建任何订单/游客/应收应付/余额/租户用户的镜像表 | [PRD §2.2] [PRD §9.1] |
| 禁止直改 | 任何 ops 代码不得 `INSERT/UPDATE/DELETE public.*` 业务表；`public.audit_events` 也不写（其 `organization_id NOT NULL`，ops 事件另有表） | [PRD §2.2]；表结构见 `20261003000000_identity.sql` [继承] |
| 读取限制 | ops 不得通过 API 返回租户内部员工、订单、游客、账款明细；仅返回状态摘要 | [PRD §6.7] [PRD §10.2] |

---

## 3. 运营数据域模型

### 3.0 通用约定（对所有表生效）

| 约定 | 内容 | 来源 |
| --- | --- | --- |
| schema | `ops` | [PRD §9.2] |
| 主键 | `id uuid PRIMARY KEY DEFAULT gen_random_uuid()` | [继承] |
| 乐观锁 | 可变聚合根带 `version integer NOT NULL DEFAULT 1 CHECK (version > 0)`；PATCH 必须回传 `version`，不匹配返回 409 `CONFLICT` | [继承 `customers.version` 与 `routes.ts` 乐观锁实现] |
| 审计列 | `created_by uuid NOT NULL REFERENCES auth.users(id)`、`updated_by uuid`、`created_at`、`updated_at`（`timestamptz NOT NULL DEFAULT now()`） | [继承]；PRD 要求可追溯到操作者 [PRD §1.3] |
| 软删除 | 商业实体不物理删除：`archived_at`、`archived_by`、`archive_reason`；状态机终态即归档位 | [PRD §6.2]「不提供无约束物理删除」[PRD §6.4]「不物理删除历史」 |
| 不可变表 | 快照、流水、时间线、尝试记录、审计、命令：**不授予 `authenticated` 的 `UPDATE`/`DELETE` 权限**，写入只经 `SECURITY DEFINER` 函数 | [PRD §6.5] [PRD §6.9] [PRD §10.3]；用 grant 而非触发器实现，拒绝路径可被 pgTAP 直接证明 |
| 编号 | `customer_no`、`contract_no`、`receipt_no`、`refund_no`、`ticket_no`、`instance_no`、`command_no` 全局唯一；生成规则 `前缀-YYYY-6 位序号`，由 PG sequence 生成，允许空洞 | [推导] 允许空洞是序列的固有语义，比"补号"事务更可靠 |
| 单运营组织 | ops 表**不带** `organization_id`；整个部署属于唯一软件提供方法人 | [推导] PRD 面向「软件提供方内部员工」单一主体；若未来多法人，再加 `ops_org_id` 并升级为 v2 |
| 责任人 | `owner_operator_id uuid REFERENCES ops.operators(id)`，不是 `auth.users` | [推导] 责任人必须是有效运营成员，账号禁用后仍能追溯 |

### 3.1 customer 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.customers` | `id`、`customer_no text NOT NULL`、`name text NOT NULL`、`unified_social_credit_code text`、`region_code text`、`status text NOT NULL`、`owner_operator_id uuid`、`source_note text`、`internal_note text`、`version`、审计列、`archived_at/by/reason` | `UNIQUE(customer_no)`；`INDEX(status, created_at DESC)`、`INDEX(owner_operator_id)`、`INDEX(name)`；**不**对企业名称/USCC 建唯一约束 | [PRD §6.2]「编号唯一；名称与信用代码用于重复提示，不自动合并」 |
| `ops.customer_contacts` | `id`、`customer_id uuid NOT NULL`、`name text NOT NULL`、`job_title text`、`phone text`、`email text`、`usage_scene text`、`is_primary boolean NOT NULL DEFAULT false`、`version`、审计列 | `FK(customer_id) ON DELETE RESTRICT`；`UNIQUE INDEX(customer_id) WHERE is_primary`（每客户至多一个主要联系人） | [PRD §6.2]「联系人多条、标记主要联系人和使用场景」；唯一约束 [推导] |

**客户状态机** [PRD §6.2] [PRD §8]

| 当前 | 动作 | 目标 | 权限 | 守卫 |
| --- | --- | --- | --- | --- |
| `signed` | `start_onboarding` | `onboarding` | `customer.write` | 必须至少一条联系人 |
| `onboarding` | `activate` | `active` | `customer.write` | 无 |
| `active` | `suspend` | `suspended` | `customer.write` | 需 `reason`；返回受影响的合同/授权/租户摘要供前端确认 |
| `suspended` | `resume` | `active` | `customer.write` | 需 `reason` |
| `signed`/`onboarding`/`active`/`suspended` | `terminate` | `terminated` | `customer.write` | 存在生效合同、有效授权、未关闭工单或活跃部署实例 → 409 `OBJECT_REFERENCED` [PRD §6.2] |
| `terminated` | — | 终态 | — | 无物理删除；仅可读取 |

**边界**：客户状态不联动合同、账款、租户状态，彼此独立 [PRD §6.2] [PRD §8]。

### 3.2 catalog 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.products` | `id`、`code text NOT NULL`、`name text NOT NULL`、`description text`、`lifecycle_status text NOT NULL`（`draft`/`active`/`retired`）、`version`、审计列 | `UNIQUE(code)` | [PRD §6.3]「产品编码、名称、描述、生命周期状态、可销售版本线」；枚举值 [推导] |
| `ops.product_sales_modes` | `product_id uuid NOT NULL`、`sales_mode text NOT NULL`（`saas`/`private`）、`is_enabled boolean NOT NULL DEFAULT false` | `PK(product_id, sales_mode)`；未开放的方式签约时必须拒绝 | [PRD §6.3] |
| `ops.packages` | `id`、`product_id uuid NOT NULL`、`internal_name text`、`customer_name text`、`sales_mode text NOT NULL`、`billing_type text NOT NULL`（`periodic`/`fixed_term`/`one_time`）、`default_term_months integer`、`currency char(3) NOT NULL DEFAULT 'CNY'`、`list_price numeric(14,2) NOT NULL`、`status text NOT NULL`、`effective_from date`、`effective_to date`、`current_price_version_id uuid`、`version`、审计列 | `CHECK(list_price >= 0)`；`UNIQUE(product_id, sales_mode, internal_name)`；`INDEX(status, product_id)` | [PRD §6.3]；三种计费类型为 PRD 原文「周期订阅、固定期限授权和一次性授权」 |
| `ops.package_price_versions` | `id`、`package_id uuid NOT NULL`、`version_no integer NOT NULL`、`price numeric(14,2) NOT NULL`、`currency char(3) NOT NULL`、`term_months integer`、`effective_from date NOT NULL`、`created_by`、`created_at` | `UNIQUE(package_id, version_no)`；**仅 INSERT**，无 UPDATE/DELETE 授权 | [PRD §6.3]「价格版本新增后只影响新合同」 |
| `ops.feature_definitions` | `feature_key text PRIMARY KEY`（稳定功能键）、`display_name text NOT NULL`、`value_type text NOT NULL`（`boolean`/`quota`/`term`）、`unit text`、`description text`、`is_active boolean NOT NULL DEFAULT true`、审计列 | `feature_key` 不可变（无 UPDATE 该列授权） | [PRD §6.3]「按稳定功能键定义；产品显示名变化不得改变功能键」 |
| `ops.package_features` | `package_id uuid NOT NULL`、`feature_key text NOT NULL`、`enabled boolean NOT NULL DEFAULT true`、`quota_value numeric(14,2)`、`term_months integer`、`applies_to text NOT NULL`（`saas_tenant`/`private_instance`/`both`） | `PK(package_id, feature_key)`；`FK(feature_key)` | [PRD §6.3]「支持启停、数值额度、期限和适用部署范围」 |

**规则**

- 套餐停用前必须检查草拟合同引用：存在 `status IN ('draft','reviewing')` 且引用该套餐的合同条目 → 409 `OBJECT_REFERENCED` [PRD §6.3]。
- 套餐已生效合同仍可查看；是否允许续约由 `packages.status` 明确控制：`retired` 时续约端点返回 409 `STATE_CONFLICT`（`details.reason='PACKAGE_RETIRED'`）[PRD §6.3] [推导 具体错误语义]。
- 套餐编辑不回写合同、订阅、授权快照 [PRD §6.3]。

### 3.3 contract 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.contracts` | `id`、`contract_no text NOT NULL`、`customer_id uuid NOT NULL`、`sales_owner_operator_id uuid`、`sales_mode text NOT NULL`、`currency char(3) NOT NULL`、`total_amount numeric(14,2) NOT NULL DEFAULT 0`、`payment_terms text`、`tax_note text`、`business_note text`、`status text NOT NULL`、`signed_on date`、`effective_on date`、`expires_on date`、`renewed_from_contract_id uuid`、`status_reason text`、`current_version_no integer NOT NULL DEFAULT 1`、`version`、审计列 | `UNIQUE(contract_no)`；`CHECK(total_amount >= 0)`；`CHECK(expires_on IS NULL OR effective_on IS NULL OR expires_on >= effective_on)`；`INDEX(customer_id, status)`、`INDEX(status, expires_on)`、`INDEX(sales_owner_operator_id)` | [PRD §6.4]；索引 [PRD §10.1] |
| `ops.contract_items` | `id`、`contract_id uuid NOT NULL`、`product_id`、`package_id`、`package_price_version_id`、`sales_mode`、`billing_type`、`quantity integer NOT NULL DEFAULT 1`、`unit_price numeric(14,2) NOT NULL`、`amount numeric(14,2) NOT NULL`、`term_months integer`、`entitlement_snapshot_id uuid`、`item_name_snapshot text NOT NULL` | `CHECK(amount = quantity * unit_price)`；`UNIQUE(contract_id, id)`；`amount` 与合计由服务端重算 | [PRD §6.4]「多产品条目，分别保存价格、销售方式、计费周期和权益快照」 |
| `ops.contract_versions` | `id`、`contract_id uuid NOT NULL`、`version_no integer NOT NULL`、`snapshot jsonb NOT NULL`（合同头 + 条目 + 权益快照行的完整副本）、`created_by`、`created_at`、`change_reason text NOT NULL` | `UNIQUE(contract_id, version_no)`；**仅 INSERT**；由生效/变更/续约事务写入 | [PRD §6.4]「签署后不可静默覆盖；修改形成新版本」「旧内容可查」[PRD §11.1 第 2 条] |
| `ops.contract_amendments` | `id`、`contract_id uuid NOT NULL`、`amendment_no integer NOT NULL`、`reason text NOT NULL`、`before_summary jsonb NOT NULL`、`after_summary jsonb NOT NULL`、`status text NOT NULL`（`draft`/`pending_approval`/`approved`/`rejected`/`applied`）、`requested_by`、`approved_by`、`approved_at`、`applied_version_no` | `UNIQUE(contract_id, amendment_no)`；`approved_by <> requested_by` | [PRD §6.4]；职责分离 [推导] |
| `ops.contract_attachments` | `id`、`contract_id uuid NOT NULL`、`file_name text NOT NULL`、`content_type text NOT NULL`、`byte_size bigint NOT NULL`、`storage_path text NOT NULL`、`checksum_sha256 text`、`uploaded_by`、`uploaded_at`、`access_scope text NOT NULL DEFAULT 'contract.read'` | `UNIQUE(storage_path)`；`CHECK(byte_size > 0 AND byte_size <= 26214400)`（25 MiB）[推导] | [PRD §6.4]「附件记录类型、文件名、上传人、时间和安全访问引用」 |

**合同状态机** [PRD §6.4] [PRD §8]

| 当前 | 动作 | 目标 | 权限 | 守卫 |
| --- | --- | --- | --- | --- |
| `draft` | `submit` | `reviewing` | `contract.write` | 至少一条条目；`total_amount` 等于条目合计；客户为 `signed`/`onboarding`/`active` |
| `reviewing` | `withdraw` | `draft` | `contract.write` | 无 |
| `reviewing` | `sign` | `signed` | `contract.approve` | 需 `signed_on`；`sales_mode` 必须在 `product_sales_modes.is_enabled` 中 |
| `signed` | `activate` | `active` | `contract.approve` | 需 `effective_on`；生成 `contract_versions` 快照与条目权益快照 |
| `active` | `terminate` | `terminated` | `contract.approve` | 需 `reason`；返回受影响应收/订阅/授权/租户影响摘要并要求 `confirmImpact=true` |
| `active`/`signed` | `expire` | `expired` | `contract.approve` | 到达 `expires_on` 或人工标记；不得由 PATCH 改状态 |
| `expired`/`terminated` | — | 终态 | — | 续约另建新合同并写 `renewed_from_contract_id` |

**核心规则**

- `status IN ('active','expired','terminated')` 时，合同头与条目**禁止**通过 PATCH 修改；只能走 `contract_amendments` → 新 `contract_versions` [PRD §6.4]。
- 合同签署 ≠ 已收款；收款状态独立计算，不写入合同状态 [PRD §6.4]。
- 续约：新建合同 + `renewed_from_contract_id`，记录续约前后期限/产品/权益差异到 `contract_versions.change_reason` 与 `contract_amendments`（若同合同变更）[PRD §6.4]。
- 合同金额由条目合计复算；`total_amount` 是服务器维护的缓存，不一致以条目为准 [PRD §10.3]。

### 3.4 billing 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.receivables` | `id`、`contract_id uuid NOT NULL`、`customer_id uuid NOT NULL`、`period_no integer NOT NULL`、`due_date date NOT NULL`、`amount numeric(14,2) NOT NULL`、`currency char(3) NOT NULL`、`allocated_amount numeric(14,2) NOT NULL DEFAULT 0`、`reversed_amount numeric(14,2) NOT NULL DEFAULT 0`、`note text`、`version`、审计列 | `UNIQUE(contract_id, period_no)`；`UNIQUE(id, customer_id, currency)`（供复合外键）；`CHECK(amount > 0)`、`CHECK(allocated_amount BETWEEN 0 AND amount)`、`CHECK(reversed_amount BETWEEN 0 AND amount)`；`INDEX(due_date, currency)`、`INDEX(customer_id, due_date)`、`INDEX(contract_id)` | [PRD §6.5]「一合同多期，含计划日期、金额、已核销金额、未收余额、状态、备注」 |
| `ops.receivable_extensions` | `id`、`receivable_id uuid NOT NULL`、`previous_due_date date NOT NULL`、`new_due_date date NOT NULL`、`reason text NOT NULL`、`created_by`、`created_at` | `CHECK(new_due_date > previous_due_date)`；**仅 INSERT**，保留原到期日 | [PRD §6.5]「展期」；Task 5 负责人默认规则「仅未结清应收可展期，追加展期记录并保留原到期日」 |
| `ops.receipts` | `id`、`receipt_no text NOT NULL`、`customer_id uuid NOT NULL`、`contract_id uuid`（可空＝未指定合同）、`transaction_date date NOT NULL`、`amount numeric(14,2) NOT NULL`、`currency char(3) NOT NULL`、`method_code text NOT NULL`、`reference_no text`、`voucher_ref text`、`status text NOT NULL`、`recorded_by uuid NOT NULL`、`approved_by uuid`、`approved_at timestamptz`、`recorded_reason text`、`version` | `UNIQUE(receipt_no)`；`UNIQUE(id, customer_id, currency)`；`CHECK(amount > 0)`；`CHECK(approved_by IS NULL OR approved_by <> recorded_by)`；`INDEX(customer_id, status)`、`INDEX(transaction_date)`、`INDEX(status)` | [PRD §6.5]；登记人≠审核人 [Task 5 负责人默认规则 + PRD §4.3 高风险动作] |
| `ops.receipt_allocations` | `id`、`receipt_id uuid NOT NULL`、`receivable_id uuid NOT NULL`、`amount numeric(14,2) NOT NULL`、`customer_id uuid NOT NULL`、`currency char(3) NOT NULL`、`allocated_by uuid NOT NULL`、`allocated_at timestamptz NOT NULL DEFAULT now()` | 复合外键 `(receipt_id, customer_id, currency)` → `receipts`，`(receivable_id, customer_id, currency)` → `receivables`（**跨客户/跨币种核销在数据库层无法成立**）；`CHECK(amount > 0)`；**仅 INSERT** | [PRD §6.5]「分配总额不得超过收款金额或应收余额，事务防并发超额」 |
| `ops.receipt_allocation_reversals` | `id`、`allocation_id uuid NOT NULL`、`amount numeric(14,2) NOT NULL`、`reason text NOT NULL`、`reversed_by uuid NOT NULL`、`created_at` | `CHECK(amount > 0)`；**仅 INSERT**；`(allocation_id)` 引用原分配，不覆盖原流水 | [PRD §6.5]「撤销核销须有原因、权限、反向流水和审计」 |
| `ops.refunds` | `id`、`refund_no text NOT NULL`、`receipt_id uuid NOT NULL`、`contract_id uuid`、`customer_id uuid NOT NULL`、`amount numeric(14,2) NOT NULL`、`currency char(3) NOT NULL`、`refund_date date NOT NULL`、`reason text NOT NULL`、`external_voucher_ref text`、`status text NOT NULL`、`handled_by uuid NOT NULL`、`approved_by uuid`、审计列 | `UNIQUE(refund_no)`；`CHECK(amount > 0)`；累计退款额 ≤ 对应收款已核销净额 | [PRD §6.5]「关联原收款/合同，记录金额、原因、日期、经办人和外部凭证；不调用渠道发起退款」 |

**应收状态：派生值，不落库** [PRD §6.5] [PRD §8]

`ops.receivables` 不存 `status` 列。API 用下述优先级函数计算（同一函数供列表筛选、总览、报表复用，保证「图表与列表同一口径」[PRD §6.1]）：

| 优先级 | 状态 | 条件（`net = allocated_amount - 归属于该期的 reversed_amount`，`today = Asia/Shanghai 今日`） |
| --- | --- | --- |
| 1 | `reversed` | `reversed_amount > 0` 且 `net <= 0` |
| 2 | `paid` | `net >= amount` |
| 3 | `overdue` | `net < amount` 且 `due_date < today` |
| 4 | `partial` | `0 < net < amount` 且 `due_date >= today` |
| 5 | `upcoming` | `net = 0` 且 `due_date >= today` |
| — | `unpaid` | **保留值，v1 不返回**；语义与 `overdue` 重叠，见 §11 不确定性 U-02 |

**收款状态机** [PRD §6.5] [PRD §8]

| 当前 | 动作 | 目标 | 权限 | 守卫 |
| --- | --- | --- | --- | --- |
| — | `record` | `recorded` | `receipt.record` | 必填 `Idempotency-Key`；客户存在；金额 > 0；币种与合同一致 |
| `recorded` | `approve` | `pending_reconcile` | `receipt.approve` | `approved_by <> recorded_by`，否则 403 `FORBIDDEN`（`details.rule='SEGREGATION_OF_DUTY'`）；未审核不计入实收 |
| `recorded` | `reject` | `recorded`（保留） | `receipt.approve` | 写审计 `receipt.rejected`，记录原因；不删除记录 |
| `pending_reconcile` | 首次核销 | `reconciled` | `receipt.reconcile` | 核销总额 ≤ 收款金额；核销额 ≤ 应收余额 |
| `reconciled` | 追加核销 | `reconciled` | `receipt.reconcile` | 同上 |
| `recorded`/`pending_reconcile`/`reconciled` | `reverse` | `reversed` | `receipt.reverse` | 需 `reason`；已有核销须先撤销核销；生成反向流水，原记录保留 |
| `reconciled` | 全额退款完成 | `refunded` | `receipt.refund` | 累计已审核退款额 = 收款额；部分退款不改变收款状态 |

**核销并发不变量（必须在单个事务/RPC 内）** [PRD §6.5] [PRD §10.3]

1. `SELECT ... FOR UPDATE` 锁定涉及的 `receipts` 与全部 `receivables` 行。
2. 校验：`sum(本次分配) <= receipt.amount - 已分配净额`，且每个应收 `allocated_amount + 本次 <= amount + reversed_amount`。
3. 更新 `receivables.allocated_amount`，插入 `receipt_allocations`，写审计 —— 同事务。
4. 任何校验失败整笔回滚：超额 → 409 `STATE_CONFLICT`（`RECEIPT_EXCEEDED` / `RECEIVABLE_EXCEEDED`）；跨客户/跨币种 → 400 `VALIDATION_ERROR`（`CUSTOMER_MISMATCH` / `CURRENCY_MISMATCH`）。

### 3.5 entitlement 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.subscriptions` | `id`、`subscription_no text NOT NULL`、`customer_id`、`contract_id`、`contract_item_id`、`product_id`、`package_id`、`billing_cycle text NOT NULL`（`monthly`/`quarterly`/`yearly`/`multi_year`）、`starts_on date NOT NULL`、`ends_on date`、`auto_renew_intent boolean NOT NULL DEFAULT false`、`status text NOT NULL`、`current_snapshot_id uuid`、`version`、审计列 | `UNIQUE(subscription_no)`；`CHECK(ends_on IS NULL OR ends_on >= starts_on)`；`INDEX(status, ends_on)`、`INDEX(customer_id)` | [PRD §6.6]「客户、产品、套餐、计费周期、起止时间、自动续订意向（仅记录）、当前权益快照、状态」 |
| `ops.private_licenses` | `id`、`license_no text NOT NULL`、`customer_id`、`contract_id`、`contract_item_id`、`deployment_instance_id uuid`、`license_mode text NOT NULL`（`term`/`perpetual`）、`valid_from date NOT NULL`、`valid_to date`、`maintenance_until date`、`status text NOT NULL`、`current_snapshot_id uuid`、`version`、审计列 | `UNIQUE(license_no)`；`CHECK((license_mode='perpetual') = (valid_to IS NULL))`；`CHECK(valid_to IS NULL OR valid_to >= valid_from)` | [PRD §6.6]「部署实例、授权方式、有效期/永久标志、维护期限和权益快照；永久授权不得推导为永久更新」 |
| `ops.entitlement_snapshots` | `id`、`customer_id NOT NULL`、`source_type text NOT NULL`（`contract_item`/`change_request`）、`source_id uuid NOT NULL`、`target_scope text NOT NULL`（`saas_tenant`/`private_instance`）、`target_ref uuid`、`valid_from date`、`valid_to date`、`created_by`、`created_at`、`content_hash text NOT NULL` | **仅 INSERT**；`UNIQUE(source_type, source_id, content_hash)` 防重复发放 | [PRD §6.6]「发放后不可静默覆写，只能新增变更记录」 |
| `ops.entitlement_snapshot_lines` | `snapshot_id uuid NOT NULL`、`feature_key text NOT NULL`、`enabled boolean NOT NULL`、`quota_value numeric(14,2)`、`term_months integer`、`display_name_snapshot text NOT NULL` | `PK(snapshot_id, feature_key)`；**仅 INSERT** | [PRD §6.6]「功能键、启用状态、额度、期限和目标租户/部署实例」 |
| `ops.entitlement_change_requests` | `id`、`subject_type text NOT NULL`（`subscription`/`license`）、`subject_id uuid NOT NULL`、`change_type text NOT NULL`（`issue`/`extend`/`upgrade`/`downgrade`/`quota_change`/`suspend`/`resume`/`expire`/`revoke`）、`source_contract_id uuid`、`proposed_snapshot_id uuid`、`status text NOT NULL`、`reason text NOT NULL`、`before_summary jsonb NOT NULL`、`after_summary jsonb NOT NULL`、`requested_by uuid`、`approved_by uuid`、`approved_at`、`executed_at`、`command_id uuid`、`version` | `CHECK(approved_by IS NULL OR approved_by <> requested_by)`；`INDEX(status, created_at)`；`INDEX(subject_type, subject_id)` | [PRD §6.6]「支持新发/延期/升级/降级/额度变更/暂停/恢复/到期/撤销；保存来源合同、操作者、原因、审核结果、前后值摘要和同步结果」 |

**订阅/授权状态机** [PRD §6.6] [PRD §8]

| 当前 | 动作 | 目标 | 权限 | 守卫 |
| --- | --- | --- | --- | --- |
| — | `create_draft` | `draft` | `entitlement.request` | 来源合同必须 `active`（或 `signed` 且 `effective_on <= today`） |
| `draft` | `submit` | `pending_approval` | `entitlement.request` | 必须有 `proposed_snapshot_id` 与权益差异预览 |
| `pending_approval` | `approve` | `active` | `entitlement.approve` | 未审批执行 → 409 `STATE_CONFLICT`（`details.reason='APPROVAL_REQUIRED'`）[PRD §6.6] |
| `pending_approval` | `reject` | `draft` | `entitlement.approve` | 记录原因 |
| `active` | `suspend` | `suspended` | `entitlement.execute` | 需 `reason`；生成租户命令 |
| `suspended` | `resume` | `active` | `entitlement.execute` | 需 `reason` |
| `active`/`suspended` | `revoke` | `revoked` | `entitlement.execute` | 需 `reason`；高风险二次确认 |
| `active` | `mark_expired` | `expired` | `entitlement.execute` | `valid_to < today`；不删除数据 |
| `revoked`/`expired` | — | 终态 | — | 只能新建 |

**变更申请状态机（推导）**

| 当前 | 动作 | 目标 | 权限 |
| --- | --- | --- | --- |
| `draft` | `submit` | `pending_approval` | `entitlement.request` |
| `pending_approval` | `approve` | `approved` | `entitlement.approve` |
| `pending_approval` | `reject` | `rejected` | `entitlement.approve` |
| `approved` | `execute` | `executing` → `executed` | `entitlement.execute` |
| `approved`/`executing` | `fail` | `failed` | 系统（命令失败） |
| `failed` | `retry` | `executing` | `entitlement.execute` + `tenant.retry` |
| `draft`/`pending_approval`/`approved` | `cancel` | `cancelled` | `entitlement.request` 或 `entitlement.approve` |

> 该状态集 PRD 未枚举，属于实现必需的状态机；来源标 [推导]，登记为 U-04。

### 3.6 tenant-integration 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.tenant_mappings` | `id`、`mapping_no text NOT NULL`、`customer_id uuid NOT NULL`、`product_id uuid NOT NULL`、`udone_organization_id uuid NOT NULL`（外部 ID）、`external_ref text`、`mapping_status text NOT NULL`（`pending`/`active`/`suspended`/`terminated`）、`last_known_state text`、`last_synced_at`、`sync_version integer NOT NULL DEFAULT 0`、`version`、审计列 | `UNIQUE(udone_organization_id)` —— **一个租户只能指向一个商业客户**；`UNIQUE(customer_id, product_id, udone_organization_id)`；`INDEX(customer_id)`、`INDEX(mapping_status)` | [PRD §6.7]「每个租户映射只能指向唯一商业客户，冲突时拒绝」 |
| `ops.tenant_commands` | `id`、`command_no text NOT NULL`、`idempotency_key text NOT NULL`、`mapping_id uuid`、`command_type text NOT NULL`（`provision`/`bind`/`activate`/`suspend`/`resume`/`sync_entitlement`/`extend`/`revoke`）、`customer_id`、`contract_id`、`change_request_id`、`expected_sync_version integer`、`reason text NOT NULL`、`status text NOT NULL`、`attempt_count integer NOT NULL DEFAULT 0`、`last_error_code text`、`last_error_category text`（`transient`/`permanent`/`auth`/`conflict`/`unknown`）、`request_summary jsonb`、`response_summary jsonb`、`request_id text`、`next_retry_at timestamptz`、`created_by`、`completed_at`、`version` | `UNIQUE(idempotency_key)`；`UNIQUE(command_no)`；`CHECK(expected_sync_version >= 0)`；`INDEX(status, created_at)`、`INDEX(mapping_id, created_at DESC)` | [PRD §6.7]「唯一幂等键、操作者、业务原因、合同/授权引用、期望版本、最近请求/响应摘要、重试次数、错误类别」 |
| `ops.tenant_command_attempts` | `id`、`command_id uuid NOT NULL`、`attempt_no integer NOT NULL`、`started_at`、`finished_at`、`outcome text NOT NULL`（`succeeded`/`failed`/`timeout`）、`http_status integer`、`error_category text`、`request_id text`、`response_summary jsonb`、`actor_id uuid` | `UNIQUE(command_id, attempt_no)`；**仅 INSERT** | [PRD §6.7]「超时先查询命令状态再重试」「保留请求 ID 与安全摘要，不记录密钥或完整敏感载荷」 |

**租户命令状态机** [PRD §6.7] [PRD §8]

| 当前 | 动作 | 目标 | 权限 | 守卫 |
| --- | --- | --- | --- | --- |
| — | `create` | `pending` | 按 `command_type` 映射：`provision`/`bind`/`activate`→`tenant.provision`；`suspend`→`tenant.suspend`；`resume`→`tenant.restore`；`sync_entitlement`/`extend`/`revoke`→`entitlement.execute` | 关联变更申请必须 `approved`；映射已存在时 `expected_sync_version` 必须等于 `mapping.sync_version`；`reason` 必填 |
| `pending` | `dispatch_success` | `succeeded` | 系统 | `sync_version += 1`，更新映射状态摘要；写审计 |
| `pending` | `dispatch_fail_transient` | `failed` | 系统 | `next_retry_at = now() + backoff(attempt_count)` |
| `pending` | `dispatch_fail_permanent` | `failed` | 系统 | `last_error_category='permanent'`，禁止重试 |
| `pending` | `timeout` | `pending`（结果未知） | 系统 | 记录 `attempts.outcome='timeout'`；必须先查询远端状态 |
| `failed` | `retry` | `retrying` | `tenant.retry` | `last_error_category <> 'permanent'`，否则 409 `STATE_CONFLICT`（`details.reason='PERMANENT_ERROR'`）；复用同一幂等键 |
| `retrying` | `dispatch_success`/`dispatch_fail_*` | `succeeded`/`failed` | 系统 | 同上 |
| `pending` | `cancel` | `cancelled` | 同创建权限 | 仅未发生任何尝试；`succeeded` 不可取消、不可删除 |

**边界**

- 映射冲突（`udone_organization_id` 已存在）→ 409 `CONFLICT`（`details.reason='TENANT_MAPPING_CONFLICT'`），不得自动改绑 [PRD §6.7]。
- 同步失败不得把运营侧状态改成成功；失败进入交付待办 [PRD §6.7] [PRD §10.3]。

### 3.7 deployment 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.deployment_instances` | `id`、`instance_no text NOT NULL`、`customer_id uuid NOT NULL`、`name text NOT NULL`、`deployment_type text NOT NULL`（`private`/`dedicated`）、`environment_ref text`、`current_version text`、`status text NOT NULL`、`go_live_on date`、`maintenance_until date`、`owner_operator_id uuid`、`contract_id uuid`、`license_id uuid`、`version`、审计列 | `UNIQUE(instance_no)`；`UNIQUE(customer_id, name)`；`INDEX(status, maintenance_until)`、`INDEX(current_version)`、`INDEX(customer_id)` | [PRD §6.8]「实例名称/编号、部署类型、客户环境标识、当前版本、部署状态、授权关联、上线日期、维护到期日、负责人」 |
| `ops.deployment_version_records` | `id`、`instance_id uuid NOT NULL`、`from_version text NOT NULL`、`to_version text NOT NULL`、`executed_on date NOT NULL`、`executed_by uuid NOT NULL`、`result text NOT NULL`（`succeeded`/`failed`/`rolled_back`）、`impact_note text`、`rollback_note text`、`created_at` | **仅 INSERT**；`INDEX(instance_id, executed_on DESC)` | [PRD §6.8]「升级登记前后版本、执行日期、操作人、结果、影响说明和回滚备注」 |

**禁止列清单（安全红线）** [PRD §6.8] [PRD §10.2]

`ops.deployment_instances` 与任何相关表**不得**出现：`ssh_private_key`、`ssh_password`、`db_password`、`root_password`、`admin_token`、`connection_string`、`install_package_url`。代码评审与 pgTAP 均需断言表内无此类列（用 `information_schema.columns` 白名单测试）。

**实例状态机** [PRD §6.8] [PRD §8]

| 当前 | 动作 | 目标 | 权限 |
| --- | --- | --- | --- |
| — | `create` | `planned` | `deployment.write` |
| `planned` | `go_live` | `active` | `deployment.write`（需 `go_live_on`） |
| `active` | `start_maintenance` | `maintenance` | `deployment.write` |
| `maintenance` | `end_maintenance` | `active` | `deployment.write` |
| `planned`/`active`/`maintenance` | `retire` | `retired` | `deployment.write`（需 `reason`） |
| `retired` | — | 终态 | — |

环境状态不得自动改变合同或授权状态 [PRD §8]。

### 3.8 support 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.tickets` | `id`、`ticket_no text NOT NULL`、`customer_id uuid NOT NULL`、`product_id uuid`、`contract_id uuid`、`tenant_mapping_id uuid`、`deployment_instance_id uuid`、`subject text NOT NULL`、`description text NOT NULL`、`issue_type text NOT NULL`、`priority text NOT NULL`、`status text NOT NULL`、`assignee_operator_id uuid`、`waiting_on text`、`resolution_summary text`、`due_at timestamptz`、`closed_at`、`reopen_count integer NOT NULL DEFAULT 0`、`version`、审计列 | `UNIQUE(ticket_no)`；`CHECK(status <> 'waiting' OR (waiting_on IS NOT NULL AND length(btrim(waiting_on)) > 0))`；`CHECK(priority IN ('urgent','high','normal','low'))`；`INDEX(status, priority, updated_at DESC)`、`INDEX(assignee_operator_id, status)`、`INDEX(customer_id)` | [PRD §6.9]「编号、主题、描述、问题类型、优先级、状态、负责人、创建/更新时间、关闭摘要」「等待状态需要等待对象或备注」；优先级枚举 [推导] |
| `ops.ticket_events` | `id`、`ticket_id uuid NOT NULL`、`event_type text NOT NULL`（`created`/`assigned`/`status_changed`/`comment`/`linked`/`reopened`/`closed`）、`from_status text`、`to_status text`、`actor_id uuid NOT NULL`、`body text`、`waiting_on text`、`metadata jsonb NOT NULL DEFAULT '{}'`、`created_at` | **仅 INSERT**；`INDEX(ticket_id, created_at)` | [PRD §6.9]「每次分派、状态变化、处理说明、沟通摘要追加到不可覆盖时间线」 |
| `ops.ticket_references` | `ticket_id uuid NOT NULL`、`ref_type text NOT NULL`（`tenant_command`/`entitlement_change`/`deployment_version`）、`ref_id uuid NOT NULL`、`created_by`、`created_at` | `PK(ticket_id, ref_type, ref_id)`；**仅 INSERT** | [PRD §6.9]「可关联租户同步任务、授权变更和部署升级记录」 |

**工单状态机** [PRD §6.9] [PRD §8]

| 当前 | 动作 | 目标 | 权限 | 守卫 |
| --- | --- | --- | --- | --- |
| — | `create` | `new` | `ticket.create` | 至少关联客户 |
| `new` | `assign` | `assigned` | `ticket.assign` | 需 `assigneeOperatorId` |
| `assigned` | `start` | `in_progress` | `ticket.update` | 无 |
| `in_progress` | `wait` | `waiting` | `ticket.update` | 必须给 `waitingOn` |
| `waiting` | `resume` | `in_progress` | `ticket.update` | 无 |
| `in_progress`/`waiting` | `resolve` | `resolved` | `ticket.update` | 必须给 `resolutionSummary` |
| `resolved` | `close` | `closed` | `ticket.close` | 无 |
| `resolved`/`closed` | `reopen` | `in_progress` | `ticket.close` | 需 `reason`；`reopen_count += 1`；写 `reopened` 事件 |
| `closed` | — | 可重开，不可删除 | — | — |

非法迁移统一 409 `STATE_CONFLICT`，`details.allowedActions` 返回当前可用动作，供前端渲染。

### 3.9 identity-audit 域

| 表 | 关键列 | 约束 / 索引 | 来源 |
| --- | --- | --- | --- |
| `ops.operators` | `id uuid PK`、`user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT`、`email text NOT NULL`、`display_name text`、`status text NOT NULL`（`invited`/`active`/`disabled`）、`mfa_required boolean NOT NULL DEFAULT false`、`invited_by uuid`、`last_login_at`、`disabled_at`、`disabled_reason text`、审计列 | `UNIQUE(user_id)`；`UNIQUE(lower(email))`；`INDEX(status)` | [PRD §4.1] [PRD §4.3]；`mfa_required` [PRD §4.3] 二次认证策略占位（见 U-09） |
| `ops.roles` | `id`、`code text NOT NULL`、`name text NOT NULL`、`description text`、`is_system boolean NOT NULL DEFAULT false`、`status text NOT NULL` | `UNIQUE(code)`；6 个预置角色 `is_system=true` | [PRD §4.2] |
| `ops.permissions` | `code text PRIMARY KEY`、`domain text NOT NULL`、`description text NOT NULL`、`is_high_risk boolean NOT NULL DEFAULT false` | 由迁移 seed，只读 | [PRD §4.2]；`is_high_risk` [PRD §4.3] |
| `ops.role_permissions` | `role_id uuid NOT NULL`、`permission_code text NOT NULL` | `PK(role_id, permission_code)`；写入需 `role.manage` | [PRD §4.2] [PRD §4.3] |
| `ops.operator_roles` | `operator_id uuid NOT NULL`、`role_id uuid NOT NULL`、`granted_by uuid NOT NULL`、`granted_at` | `PK(operator_id, role_id)`；一个账号至少一个角色（删除最后一条角色 → 409 `STATE_CONFLICT`） | [PRD §4.3]「每个运营账号必须有启用状态和至少一个运营角色」；多角色并集 [推导] |
| `ops.audit_events` | `id`、`actor_operator_id uuid`、`actor_user_id uuid`、`action text NOT NULL`、`entity_type text NOT NULL`、`entity_id uuid`、`request_id text`、`reason text`、`before_summary jsonb`、`after_summary jsonb`、`created_at` | **仅 INSERT**；`INDEX(created_at DESC)`、`INDEX(entity_type, entity_id)`、`INDEX(actor_operator_id, created_at DESC)`、`INDEX(action)` | [PRD §6.10]「操作者 ID、动作、目标对象、时间、请求 ID、原因、前后值摘要」 |
| `ops.idempotency_records` | `scope text NOT NULL`（如 `POST /api/v1/ops/receipts`）、`key text NOT NULL`、`actor_id uuid`、`request_hash text NOT NULL`、`response_status integer NOT NULL`、`response_body jsonb NOT NULL`、`created_at`、`expires_at timestamptz NOT NULL` | `PK(scope, key)`；`INDEX(expires_at)` | [推导] 现有中间件为进程内存，不能保护钱款与命令；见 U-06 |
| `ops.dictionaries` | `code text PRIMARY KEY`、`name text NOT NULL`、`description text`、`is_system boolean NOT NULL DEFAULT false` | — | [PRD §5.10] 字典配置 |
| `ops.dictionary_items` | `id`、`dictionary_code text NOT NULL`、`value text NOT NULL`、`label text NOT NULL`、`sort_order integer NOT NULL DEFAULT 0`、`is_active boolean NOT NULL DEFAULT true` | `UNIQUE(dictionary_code, value)` | [PRD §6.5]「内部配置的收款方式」[PRD §6.9]「问题类型配置可扩展」 |
| `ops.settings` | `key text PRIMARY KEY`、`value jsonb NOT NULL`、`updated_by uuid`、`updated_at` | `key` 白名单：`overview.expiryWindowDays`、`ticket.dueHours`、`retention.exportDays` | [PRD §6.1]「窗口值可配置」[PRD §6.9]「内部工作时限可配置」[PRD §6.10]「通知阈值」 |
| `ops.exports` | `id`、`export_no text NOT NULL`、`export_type text NOT NULL`、`filters jsonb NOT NULL`、`status text NOT NULL`（`queued`/`running`/`succeeded`/`failed`/`expired`）、`requested_by uuid NOT NULL`、`row_count integer`、`storage_path text`、`expires_at`、`created_at`、`completed_at` | `UNIQUE(export_no)`；`INDEX(requested_by, created_at DESC)` | [PRD §6.10]「重大数据导出需单独权限，记录导出者、筛选条件、时间和对象范围」 |

**运营身份与权限的来源约束**

- 运营权限只能来自 `ops.operators` + `ops.operator_roles` + `ops.role_permissions`，**不得**读取 `user_metadata`、`app_metadata.role` 等可被自助修改或由第三方写入的字段 [PRD §4.3]。
- 禁用/撤销角色即时生效：每个请求都查 `operators.status`（经 RPC，不缓存进 token）[PRD §4.3]。
- 角色变更必须记录变更前后权限摘要到 `audit_events`（`action='role.permissions_changed'`，`before_summary`/`after_summary`）[PRD §4.3]。

**预置角色 → 权限映射（初始 seed，可由管理员调整，不代表后端分支）** [PRD §4.2]

| 角色 code | 中文名 | 权限集合 |
| --- | --- | --- |
| `platform_admin` | 平台管理员 | 全部权限（敏感动作仍需对应动作码；不做超级用户绕过） |
| `sales_ops` | 商务运营 | `customer.read/write/sensitive.read`、`catalog.read`、`contract.read/write`、`receivable.read`、`entitlement.read/request`、`tenant.read`、`deployment.read`、`ticket.read/create/update`、`overview.read`、`export.create` |
| `finance_ops` | 财务运营 | `customer.read`、`contract.read`、`receivable.read/write`、`receipt.record/approve/reconcile/refund/reverse`、`entitlement.read`、`audit.read`、`overview.read`、`export.create` |
| `delivery_ops` | 交付运营 | `customer.read/write`、`catalog.read`、`contract.read`、`entitlement.read/request/execute`、`tenant.read/provision/suspend/restore/retry`、`deployment.read/write`、`ticket.read/update`、`overview.read` |
| `support_agent` | 售后支持 | `customer.read`、`contract.read`、`entitlement.read`、`tenant.read`、`deployment.read`、`ticket.read/create/assign/update/close`、`overview.read`（**无** `customer.sensitive.read`、**无**任何 `receivable.*`）[PRD §4.2] 明确「不得读取不必要的完整收款敏感信息」 |
| `ops_viewer` | 运营只读 | `customer.read`、`catalog.read`、`contract.read`、`receivable.read`、`entitlement.read`、`tenant.read`、`deployment.read`、`ticket.read`、`overview.read`、`audit.read` |

> `entitlement.approve` 与 `contract.approve` 不在同一角色默认集合里（职责分离），由管理员按实际分工授予 [PRD §4.2]。

---

## 4. 权限动作目录

**规则：后端只判断动作码，不判断角色名** [PRD §4.2]。动作码唯一真源是 `ops.permissions` 表 + `packages/contracts/src/ops/permissions.ts`，两处必须一致（pgTAP 与单测双重对账）。

| 动作码 | 含义 | 归属域 | 风险级别 | 来源 |
| --- | --- | --- | --- | --- |
| `overview.read` | 查看运营总览与下钻指标 | identity-audit | 低 | [推导] PRD §6.1 只写「受权限控制」 |
| `customer.read` | 查看客户、联系人（联系方式掩码） | customer | 低 | [PRD §4.2] |
| `customer.write` | 新建/编辑/停用客户与联系人 | customer | 中 | [PRD §4.2] |
| `customer.sensitive.read` | 查看联系人电话/邮箱原值 | customer | 中 | [推导] PRD §10.2「最小化展示」；与 udone `customer.sensitive.read` 对齐 [继承] |
| `catalog.read` | 查看产品、套餐、价格版本、功能键 | catalog | 低 | [推导] PRD §4.2 未列，模块必需 |
| `catalog.write` | 维护产品/套餐/价格版本/功能键/套餐权益 | catalog | 中 | [推导] 同上 |
| `contract.read` | 查看合同、条目、版本、附件列表 | contract | 低 | [PRD §4.2] |
| `contract.write` | 草拟/编辑/提交/续约发起/变更单提交 | contract | 中 | [PRD §4.2] |
| `contract.approve` | 签署确认、生效、终止、变更单批准 | contract | 高 | [PRD §4.2] [PRD §6.4] |
| `receivable.read` | 查看应收计划、收款、核销、退款、导出账款明细 | billing | 低 | [PRD §4.2] |
| `receivable.write` | 生成/调整应收计划、展期 | billing | 中 | [PRD §4.2] [Task 5 负责人默认规则] |
| `receipt.record` | 登记线下收款 | billing | 中 | [PRD §4.2] |
| `receipt.approve` | 审核/驳回收款登记（审核后计入实收） | billing | 高 | [Task 5 负责人默认规则] [PRD §6.5]；PRD §4.2 未单列 → [推导] |
| `receipt.reconcile` | 核销收款到应收 | billing | 高 | [PRD §4.2] |
| `receipt.reverse` | 撤销核销、收款冲正 | billing | 高 | [推导] PRD §6.5「撤销核销须有原因、权限、反向流水」 |
| `receipt.refund` | 登记退款 | billing | 高 | [PRD §4.2] |
| `entitlement.read` | 查看订阅、授权、权益快照、变更历史 | entitlement | 低 | [PRD §4.2] |
| `entitlement.request` | 创建订阅/授权草案、提交权益变更申请 | entitlement | 中 | [PRD §4.2] |
| `entitlement.approve` | 审核权益变更申请 | entitlement | 高 | [PRD §4.2] [PRD §6.6] |
| `entitlement.execute` | 执行已批准的权益变更并下发同步命令 | entitlement | 高 | [PRD §4.2] |
| `tenant.read` | 查看租户映射、命令状态、尝试记录 | tenant-integration | 低 | [推导] PRD §4.2 未列读权限，模块必需 |
| `tenant.provision` | 创建/绑定租户映射并发起开通 | tenant-integration | 高 | [PRD §4.2] |
| `tenant.suspend` | 暂停租户 | tenant-integration | 高 | [PRD §4.2] |
| `tenant.restore` | 恢复租户 | tenant-integration | 高 | [PRD §4.2] |
| `tenant.retry` | 重试失败命令 | tenant-integration | 高 | [推导] PRD §6.7「重试支持权限检查」 |
| `deployment.read` | 查看部署实例与升级历史 | deployment | 低 | [PRD §4.2] |
| `deployment.write` | 维护实例、登记升级结果、变更环境状态 | deployment | 中 | [PRD §4.2] [PRD §6.8] |
| `ticket.read` | 查看工单与时间线 | support | 低 | [PRD §4.2] |
| `ticket.create` | 创建工单 | support | 低 | [推导] PRD §6.9 有创建动作，§4.2 未列动作码 |
| `ticket.assign` | 分派/改派工单 | support | 中 | [PRD §4.2] |
| `ticket.update` | 处理说明、等待、解决、编辑工单字段 | support | 中 | [PRD §4.2] |
| `ticket.close` | 关闭工单、重开工单 | support | 中 | [PRD §4.2] [PRD §6.9] |
| `operator.read` | 查看运营账号与角色 | identity-audit | 低 | [推导] 账号管理页需要列表 |
| `operator.manage` | 邀请/禁用账号、分配角色 | identity-audit | 高 | [PRD §4.2] [PRD §4.3] |
| `role.manage` | 创建角色、编辑角色权限 | identity-audit | 高 | [推导] PRD §4.3「修改角色/权限仅平台管理员可做」 |
| `settings.manage` | 系统设置、字典维护 | identity-audit | 中 | [推导] PRD §5.10 |
| `audit.read` | 查询审计事件 | identity-audit | 中 | [PRD §4.2] |
| `export.read` | 查看导出任务与下载结果 | identity-audit | 中 | [推导] 与 `export.create` 分离，便于只审计不生成 |
| `export.create` | 发起数据导出 | identity-audit | 高 | [PRD §6.10]「重大数据导出需单独权限」 |

**高风险动作**（`is_high_risk=true`，必须：填写 `reason`、写审计、前端二次确认、未来接入 step-up 认证）：`contract.approve`、`receipt.approve`、`receipt.reconcile`、`receipt.reverse`、`receipt.refund`、`entitlement.approve`、`entitlement.execute`、`tenant.provision`、`tenant.suspend`、`tenant.restore`、`tenant.retry`、`operator.manage`、`role.manage`、`export.create` [PRD §1.3]「高风险动作需显式确认」[PRD §4.3]。

---

## 5. API 端点清单

**通用约定（本节所有端点）**

- 前缀：`/api/v1/ops`，下表路径省略前缀。
- 认证：`Authorization: Bearer <access_token>`；运营上下文来自 `ops.get_current_ops_context()` RPC，**不使用** `X-Organization-ID`。
- 身份失败：无 token → 401 `AUTH_REQUIRED`；有 token 但非运营成员或 `status<>'active'` → 403 `FORBIDDEN`（`details.reason='OPS_MEMBER_INACTIVE'` 或 `'OPS_MEMBER_MISSING'`）[PRD §4.3]。
- 列表端点均支持 `page`/`pageSize`/`sort`/`order` 与各自筛选字段，响应均为 `{items,total,page,pageSize}`。
- 写端点均要求 `version`（可选乐观锁除外，逐条标注）与 `reason`（高风险动作必填）。

### 5.1 meta / session / identity

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /meta` | 已认证运营成员 | — | `contractVersion`、`serverTime`、`timezone='Asia/Shanghai'`、`supportedSalesModes`、`supportedCurrencies` | 401/403 | — |
| `GET /session` | 已认证运营成员 | — | `operator{id,displayName,email,status,mfaRequired}`、`roles[{code,name}]`、`permissions[]`、`permissionVersion`、`lastLoginAt` | 401/403 | — |
| `GET /permissions` | `operator.read` | — | `items[{code,domain,description,isHighRisk}]` | 403 | — |
| `GET /operators` | `operator.read` | `keyword`、`status`、`roleCode` | `items[{id,email,displayName,status,roles,lastLoginAt}]` | 403 | — |
| `POST /operators/invitations` | `operator.manage` | `email`、`roleCodes[]`、`reason` | `operator{id,status='invited'}`、`invitationExpiresAt` | 409 `CONFLICT`（已存在）、400 | 必填 |
| `PATCH /operators/{operatorId}` | `operator.manage` | `status?`、`roleCodes?`、`mfaRequired?`、`reason`、`version` | `operator{...}`、`permissionsChanged{added,removed}` | 403、409 `STATE_CONFLICT`（最后一个角色/最后一个管理员）、409 `CONFLICT`（版本） | 必填 |
| `GET /roles` | `operator.read` | — | `items[{id,code,name,isSystem,status,permissions[]}]` | 403 | — |
| `POST /roles` | `role.manage` | `code`、`name`、`description`、`permissionCodes[]` | `role{...}` | 409 `CONFLICT`、400 | 必填 |
| `PATCH /roles/{roleId}` | `role.manage` | `name?`、`description?`、`permissionCodes?`、`status?`、`reason` | `role{...}`、`beforePermissions[]`、`afterPermissions[]` | 403、409 `STATE_CONFLICT`（系统角色不可改 code/删除） | 必填 |
| `GET /audit-events` | `audit.read` | `actorOperatorId`、`action`、`entityType`、`entityId`、`requestId`、`from`、`to` | `items[{id,actor{id,displayName},action,entityType,entityId,reason,beforeSummary,afterSummary,requestId,createdAt}]` | 403 | — |

### 5.2 customer

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /customers` | `customer.read` | `keyword`（名称/编号）、`status[]`、`ownerOperatorId`、`contractStatus`、`entitlementExpiringInDays`、排序白名单 `createdAt/updatedAt/name` | `items[{id,customerNo,name,status,owner{...},primaryContact{maskedPhone,maskedEmail},activeContractCount,createdAt}]` | 403 | — |
| `POST /customers` | `customer.write` | `name`、`unifiedSocialCreditCode?`、`regionCode?`、`sourceNote?`、`internalNote?`、`ownerOperatorId?`、`contacts[]` | `customer{...}`、`duplicateHints[{id,customerNo,name,reason}]` | 409 `CONFLICT`（编号重复）、400 | 必填 |
| `POST /customers/duplicate-check` | `customer.read` | `name`、`unifiedSocialCreditCode?` | `items[{id,customerNo,name,matchReason}]` | 400 | — |
| `GET /customers/{customerId}` | `customer.read` | — | `customer{...}`、`contacts[]`、`counts{contracts,receivables,subscriptions,licenses,deployments,tickets}` | 404 | — |
| `PATCH /customers/{customerId}` | `customer.write` | 可编辑字段 + `version` | `customer{...}` | 404、409 `CONFLICT` | 可选 |
| `POST /customers/{customerId}/transition` | `customer.write`（`terminate` 需 `customer.write`，见 §3.1） | `action`（`start_onboarding`/`activate`/`suspend`/`resume`/`terminate`）、`reason`、`version` | `customer{status,version}`、`impact{contracts,entitlements,tickets,deployments}` | 409 `STATE_CONFLICT`、409 `OBJECT_REFERENCED`（终止被引用） | 必填 |
| `GET /customers/{customerId}/overview` | `customer.read` | — | `contracts[]`、`receivables[]`、`subscriptions[]`、`licenses[]`、`tenantMappings[]`、`deployments[]`、`tickets[]`（各为摘要数组） | 404 | — |
| `GET /customers/{customerId}/contacts` | `customer.read` | — | `items[{id,name,jobTitle,phoneMasked,emailMasked,isPrimary,usageScene}]`（有 `customer.sensitive.read` 时附 `phone`/`email` 原值） | 404 | — |
| `POST /customers/{customerId}/contacts` | `customer.write` | `name`、`jobTitle?`、`phone?`、`email?`、`isPrimary?`、`usageScene?` | `contact{...}` | 404、409 `CONFLICT`（主要联系人冲突→自动降级旧主要） | 可选 |
| `PATCH /customers/{customerId}/contacts/{contactId}` | `customer.write` | 可编辑字段 + `version` | `contact{...}` | 404、409 `CONFLICT` | 可选 |
| `DELETE /customers/{customerId}/contacts/{contactId}` | `customer.write` | — | `deletedContactId` | 404、409 `STATE_CONFLICT`（唯一主要联系人且客户非 terminated） | 可选 |

### 5.3 catalog

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /products` | `catalog.read` | `keyword`、`lifecycleStatus`、`salesMode` | `items[{id,code,name,lifecycleStatus,salesModes[],packageCount}]` | 403 | — |
| `POST /products` | `catalog.write` | `code`、`name`、`description?`、`salesModes[{mode,isEnabled}]` | `product{...}` | 409 `CONFLICT`（code） | 必填 |
| `PATCH /products/{productId}` | `catalog.write` | `name?`、`description?`、`lifecycleStatus?`、`salesModes?`、`version` | `product{...}` | 404、409 `CONFLICT`、409 `STATE_CONFLICT`（停用仍被草拟合同引用→`OBJECT_REFERENCED`） | 可选 |
| `GET /packages` | `catalog.read` | `productId`、`salesMode`、`status`、`keyword` | `items[{id,productId,internalName,customerName,salesMode,billingType,price,currency,status,effectiveFrom}]` | 403 | — |
| `POST /packages` | `catalog.write` | `productId`、`internalName`、`customerName`、`salesMode`、`billingType`、`defaultTermMonths?`、`currency`、`listPrice`、`features[]`、`effectiveFrom` | `package{...}`、`priceVersion{...}` | 400（销售方式未开放）、409 `CONFLICT` | 必填 |
| `GET /packages/{packageId}` | `catalog.read` | — | `package{...}`、`features[]`、`currentPriceVersion` | 404 | — |
| `PATCH /packages/{packageId}` | `catalog.write` | `internalName?`、`customerName?`、`features?`、`version` | `package{...}` | 404、409 `CONFLICT` | 可选 |
| `POST /packages/{packageId}/price-versions` | `catalog.write` | `price`、`currency`、`termMonths?`、`effectiveFrom` | `priceVersion{...}` | 404、409 `CONFLICT`（同版本号） | 必填 |
| `GET /packages/{packageId}/price-versions` | `catalog.read` | — | `items[{versionNo,price,currency,termMonths,effectiveFrom,createdBy,createdAt}]` | 404 | — |
| `POST /packages/{packageId}/transition` | `catalog.write` | `action`（`activate`/`retire`）、`reason` | `package{status}` | 404、409 `OBJECT_REFERENCED`（草拟合同引用）、409 `STATE_CONFLICT` | 必填 |
| `GET /features` | `catalog.read` | `isActive`、`keyword` | `items[{featureKey,displayName,valueType,unit,isActive,usageCount}]` | 403 | — |
| `POST /features` | `catalog.write` | `featureKey`（不可变）、`displayName`、`valueType`、`unit?`、`description?` | `feature{...}` | 409 `CONFLICT` | 必填 |
| `PATCH /features/{featureKey}` | `catalog.write` | `displayName?`、`unit?`、`description?`、`isActive?` | `feature{...}` | 404、409 `STATE_CONFLICT`（尝试改 `featureKey`/`valueType` 且已被合同快照引用） | 可选 |

### 5.4 contract

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /contracts` | `contract.read` | `keyword`、`customerId`、`status[]`、`salesOwnerOperatorId`、`expiresFrom`、`expiresTo`、`salesMode` | `items[{id,contractNo,customer{id,name},status,salesMode,totalAmount,currency,effectiveOn,expiresOn,receivableSummary{total,settled,outstanding}}]` | 403 | — |
| `POST /contracts` | `contract.write` | `customerId`、`salesMode`、`currency`、`paymentTerms?`、`taxNote?`、`businessNote?`、`items[{productId,packageId,priceVersionId,quantity,unitPrice,termMonths?}]` | `contract{...}`、`items[]`、`entitlementPreview[]` | 400（销售方式未开放/条目为空）、404、409 `CONFLICT`（编号冲突） | 必填 |
| `GET /contracts/{contractId}` | `contract.read` | — | `contract{...}`、`items[]`、`receivables[]`、`subscriptions[]`、`licenses[]`、`attachments[]`、`allowedActions[]` | 404 | — |
| `PATCH /contracts/{contractId}` | `contract.write` | 可编辑字段（仅 `draft`/`reviewing`）、`items?`、`version` | `contract{...}` | 404、409 `CONFLICT`、409 `STATE_CONFLICT`（`details.reason='CONTRACT_IMMUTABLE'`） | 必填 |
| `POST /contracts/{contractId}/transition` | `submit`/`withdraw`→`contract.write`；`sign`/`activate`/`terminate`/`expire`→`contract.approve` | `action`、`reason?`、`signedOn?`、`effectiveOn?`、`confirmImpact?`、`version` | `contract{status,version}`、`impact{receivables,entitlements,tenantCommands}`、`createdVersionNo?` | 403、409 `STATE_CONFLICT`、409 `OBJECT_REFERENCED`（终止被财务/交付阻塞） | 必填 |
| `GET /contracts/{contractId}/versions` | `contract.read` | — | `items[{versionNo,snapshotSummary,changeReason,createdBy,createdAt}]` | 404 | — |
| `POST /contracts/{contractId}/amendments` | `contract.write` | `reason`、`changes{header?,items?}` | `amendment{status='pending_approval',beforeSummary,afterSummary}` | 404、409 `STATE_CONFLICT`（合同非 `active`） | 必填 |
| `POST /contracts/{contractId}/amendments/{amendmentId}/transition` | `contract.approve` | `action`（`approve`/`reject`）、`reason`、`version` | `amendment{status}`、`createdVersionNo?` | 403、404、409 `STATE_CONFLICT`、409 `CONFLICT` | 必填 |
| `POST /contracts/{contractId}/renewals` | `contract.write` | `effectiveOn`、`expiresOn`、`items[]`、`reason` | `contract{id,contractNo,renewedFromContractId}` | 404、409 `STATE_CONFLICT`（原合同未到期且未终止→`RENEWAL_NOT_DUE` 允许但需 `force=true` [推导]） | 必填 |
| `GET /contracts/{contractId}/entitlement-preview` | `contract.read` | — | `features[{featureKey,displayName,enabled,quota,termMonths,appliesTo}]`、`warnings[]` | 404 | — |
| `GET /contracts/{contractId}/attachments` | `contract.read` | — | `items[{id,fileName,contentType,byteSize,uploadedBy,uploadedAt}]` | 404 | — |
| `POST /contracts/{contractId}/attachments` | `contract.write` | `fileName`、`contentType`、`byteSize` | `attachment{id,status='pending'}`、`uploadUrl`、`uploadExpiresAt` | 404、400（类型/大小超限） | 必填 |
| `POST /contract-attachments/{attachmentId}/complete` | `contract.write` | `checksumSha256?` | `attachment{status='stored'}` | 404、409 `STATE_CONFLICT`（未上传） | 必填 |
| `GET /contract-attachments/{attachmentId}/access` | `contract.read` | — | `url`（≤5 分钟签名 URL）、`expiresAt` | 404 | — |

### 5.5 billing

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /receivables` | `receivable.read` | `customerId`、`contractId`、`status[]`、`dueFrom`、`dueTo`、`overdueOnly`、排序白名单 `dueDate/amount` | `items[{id,contractNo,customer{...},periodNo,dueDate,amount,allocatedAmount,outstanding,status,currency}]`、`summary{totalAmount,settledAmount,outstandingAmount,overdueAmount}` | 403 | — |
| `POST /receivables` | `receivable.write` | `contractId`、`periods[{dueDate,amount,note?}]` | `items[{id,periodNo,dueDate,amount}]` | 409 `STATE_CONFLICT`（合同未生效/非 `active`）、400（合计与合同额不符→`details.reason='PLAN_TOTAL_MISMATCH'`） | 必填 |
| `GET /receivables/{receivableId}` | `receivable.read` | — | `receivable{...}`、`allocations[]`、`extensions[]`、`reversals[]` | 404 | — |
| `POST /receivables/{receivableId}/extensions` | `receivable.write` | `newDueDate`、`reason`、`version` | `receivable{...}`、`extension{...}` | 404、409 `STATE_CONFLICT`（已结清→`RECEIVABLE_SETTLED`）、400（新日期不晚于原日期） | 必填 |
| `GET /receipts` | `receivable.read` | `customerId`、`contractId`、`status[]`、`methodCode`、`dateFrom`、`dateTo` | `items[{id,receiptNo,customer{...},transactionDate,amount,currency,method,status,allocatedAmount,recordedBy,approvedBy}]` | 403 | — |
| `POST /receipts` | `receipt.record` | `customerId`、`contractId?`、`transactionDate`、`amount`、`currency`、`methodCode`、`referenceNo?`、`voucherRef?` | `receipt{status='recorded'}`、`duplicateWarnings[]`（同流水号） | 404、400、409 `CONFLICT`（同 `referenceNo` 重复登记 [推导]） | 必填 |
| `GET /receipts/{receiptId}` | `receivable.read` | — | `receipt{...}`、`allocations[]`、`reversals[]`、`refunds[]` | 404 | — |
| `POST /receipts/{receiptId}/transition` | `receipt.approve`（`approve`/`reject`） | `action`、`reason?`、`version` | `receipt{status,approvedBy,approvedAt}` | 403 `FORBIDDEN`（`details.rule='SEGREGATION_OF_DUTY'`）、409 `STATE_CONFLICT` | 必填 |
| `POST /receipts/{receiptId}/allocations` | `receipt.reconcile` | `allocations[{receivableId,amount}]`、`reason?` | `receipt{status,allocatedAmount}`、`allocations[]`、`receivablesSummary[]` | 409 `STATE_CONFLICT`（`RECEIPT_EXCEEDED`/`RECEIVABLE_EXCEEDED`）、400（`CURRENCY_MISMATCH`/`CUSTOMER_MISMATCH`）、403（收款未审核） | 必填 |
| `POST /receipts/{receiptId}/reverse` | `receipt.reverse` | `reason`、`version` | `receipt{status='reversed'}`、`reversal{amount}` | 403、409 `STATE_CONFLICT`（存在有效核销→`HAS_ALLOCATIONS`） | 必填 |
| `POST /receipt-allocations/{allocationId}/reverse` | `receipt.reverse` | `amount`、`reason` | `allocation{reversedAmount}`、`receivable{allocatedAmount}` | 403、404、409 `STATE_CONFLICT`（超出可撤销额） | 必填 |
| `GET /refunds` | `receivable.read` | `customerId`、`status[]`、`dateFrom`、`dateTo` | `items[{id,refundNo,receiptNo,customer{...},amount,currency,refundDate,status}]` | 403 | — |
| `POST /refunds` | `receipt.refund` | `receiptId`、`contractId?`、`amount`、`refundDate`、`reason`、`externalVoucherRef?` | `refund{status='recorded'}` | 404、409 `STATE_CONFLICT`（超过可退款净额→`REFUND_EXCEEDED`） | 必填 |
| `POST /refunds/{refundId}/transition` | `receipt.refund` | `action`（`approve`/`cancel`）、`reason` | `refund{status}`、`receipt{status}` | 403、409 `STATE_CONFLICT` | 必填 |

### 5.6 entitlement

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /subscriptions` | `entitlement.read` | `customerId`、`status[]`、`expiringInDays`、`productId` | `items[{id,subscriptionNo,customer{...},product{...},status,startsOn,endsOn,autoRenewIntent}]` | 403 | — |
| `POST /subscriptions` | `entitlement.request` | `customerId`、`contractItemId`、`billingCycle`、`startsOn`、`endsOn?`、`autoRenewIntent?`、`features[]` | `subscription{status='draft'}`、`snapshot{id}` | 409 `STATE_CONFLICT`（合同未生效/条目不属于该合同）、409 `CONFLICT`（重复开通同条目） | 必填 |
| `GET /subscriptions/{subscriptionId}` | `entitlement.read` | — | `subscription{...}`、`snapshot{...}`、`changeRequests[]`、`tenantMapping?` | 404 | — |
| `POST /subscriptions/{subscriptionId}/change-requests` | `entitlement.request` | `changeType`、`reason`、`proposedFeatures[]`、`effectiveOn?` | `changeRequest{status='pending_approval'}`、`diff{before,after}` | 404、409 `STATE_CONFLICT`（订阅非 `active`/`suspended`） | 必填 |
| `GET /licenses` | `entitlement.read` | `customerId`、`status[]`、`expiringInDays`、`deploymentInstanceId` | `items[{id,licenseNo,customer{...},licenseMode,validFrom,validTo,maintenanceUntil,status}]` | 403 | — |
| `POST /licenses` | `entitlement.request` | `customerId`、`contractItemId`、`deploymentInstanceId`、`licenseMode`、`validFrom`、`validTo?`、`maintenanceUntil?`、`features[]` | `license{status='draft'}`、`snapshot{id}` | 404、409 `STATE_CONFLICT`（永久授权缺 `validTo` 反向约束） | 必填 |
| `GET /licenses/{licenseId}` | `entitlement.read` | — | `license{...}`、`snapshot{...}`、`changeRequests[]`、`deployment?` | 404 | — |
| `POST /licenses/{licenseId}/change-requests` | `entitlement.request` | 同订阅 | `changeRequest{...}`、`diff{...}` | 404、409 `STATE_CONFLICT` | 必填 |
| `GET /entitlement-change-requests` | `entitlement.read` | `subjectType`、`status[]`、`customerId`、`requestedBy` | `items[{id,subjectType,subjectId,changeType,status,requestedBy,approvedBy,createdAt}]` | 403 | — |
| `GET /entitlement-change-requests/{changeRequestId}` | `entitlement.read` | — | `changeRequest{...}`、`diff{...}`、`command?` | 404 | — |
| `POST /entitlement-change-requests/{changeRequestId}/transition` | `approve`/`reject`→`entitlement.approve`；`execute`/`retry`/`cancel`→`entitlement.execute`（`retry` 另需 `tenant.retry`） | `action`、`reason`、`version` | `changeRequest{status}`、`command{id,status}`（`execute` 返回 202） | 403、409 `STATE_CONFLICT`（`APPROVAL_REQUIRED`/`PERMANENT_ERROR`）、409 `CONFLICT` | 必填 |
| `GET /entitlement-snapshots/{snapshotId}` | `entitlement.read` | — | `snapshot{id,sourceType,sourceId,targetScope,validFrom,validTo,contentHash}`、`lines[{featureKey,enabled,quota,termMonths,displayNameSnapshot}]` | 404 | — |

### 5.7 tenant-integration

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /tenant-mappings` | `tenant.read` | `customerId`、`mappingStatus`、`productId` | `items[{id,mappingNo,customer{...},udoneOrganizationId,mappingStatus,lastKnownState,syncVersion,lastSyncedAt}]` | 403 | — |
| `POST /tenant-mappings` | `tenant.provision` | `customerId`、`productId`、`udoneOrganizationId?`、`externalRef?`、`reason` | `mapping{mappingStatus='pending'}` | 409 `CONFLICT`（`TENANT_MAPPING_CONFLICT`）、400 | 必填 |
| `GET /tenant-mappings/{mappingId}` | `tenant.read` | — | `mapping{...}`、`commands[]`（最近 20 条） | 404 | — |
| `PATCH /tenant-mappings/{mappingId}` | `tenant.provision` | `udoneOrganizationId?`、`externalRef?`、`version` | `mapping{...}` | 404、409 `CONFLICT`（改绑冲突）、409 `STATE_CONFLICT`（非 `pending` 禁止改外部 ID） | 必填 |
| `POST /tenant-mappings/{mappingId}/commands` | 按 `commandType` 映射：`provision`/`bind`/`activate`→`tenant.provision`；`suspend`→`tenant.suspend`；`resume`→`tenant.restore`；`sync_entitlement`/`extend`/`revoke`→`entitlement.execute` | `commandType`、`reason`、`contractId?`、`changeRequestId?`、`expectedSyncVersion`、`payload{features?,validFrom?,validTo?}` | 202 `command{id,commandNo,status='pending'}` | 403、409 `STATE_CONFLICT`（`expectedSyncVersion` 过期/审批未通过）、409 `CONFLICT`（幂等键冲突） | 必填 |
| `GET /tenant-commands` | `tenant.read` | `mappingId`、`status[]`、`commandType`、`createdFrom`、`createdTo` | `items[{id,commandNo,mappingId,commandType,status,attemptCount,lastErrorCategory,createdAt}]` | 403 | — |
| `GET /tenant-commands/{commandId}` | `tenant.read` | — | `command{...}`、`requestSummary`、`responseSummary`、`attempts[]`、`retryable boolean` | 404 | — |
| `GET /tenant-commands/{commandId}/attempts` | `tenant.read` | — | `items[{attemptNo,startedAt,finishedAt,outcome,httpStatus,errorCategory,requestId}]` | 404 | — |
| `POST /tenant-commands/{commandId}/retry` | `tenant.retry` + 原命令动作 | `reason`、`version` | 202 `command{status='retrying'}` | 403、409 `STATE_CONFLICT`（`PERMANENT_ERROR`/非 `failed`）、409 `CONFLICT` | 必填 |
| `POST /tenant-commands/{commandId}/cancel` | 原命令动作 | `reason`、`version` | `command{status='cancelled'}` | 403、409 `STATE_CONFLICT`（已尝试执行/`succeeded`） | 必填 |

### 5.8 deployment + support

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /deployments` | `deployment.read` | `customerId`、`status[]`、`currentVersion`、`maintenanceUntilBefore` | `items[{id,instanceNo,name,customer{...},deploymentType,currentVersion,status,maintenanceUntil,owner{...}}]` | 403 | — |
| `POST /deployments` | `deployment.write` | `customerId`、`name`、`deploymentType`、`environmentRef?`、`currentVersion?`、`goLiveOn?`、`maintenanceUntil?`、`ownerOperatorId?`、`licenseId?` | `deployment{status='planned'}` | 404、409 `CONFLICT`（同客户同名） | 必填 |
| `GET /deployments/{deploymentId}` | `deployment.read` | — | `deployment{...}`、`versionRecords[]`、`licenses[]`、`tickets[]` | 404 | — |
| `PATCH /deployments/{deploymentId}` | `deployment.write` | 可编辑字段、`version` | `deployment{...}` | 404、409 `CONFLICT` | 可选 |
| `POST /deployments/{deploymentId}/version-records` | `deployment.write` | `fromVersion`、`toVersion`、`executedOn`、`result`、`impactNote?`、`rollbackNote?` | `versionRecord{id}`、`deployment{currentVersion}` | 404、409 `STATE_CONFLICT`（`fromVersion` 与当前版本不符→`VERSION_MISMATCH`） | 必填 |
| `GET /deployments/{deploymentId}/version-records` | `deployment.read` | — | `items[{fromVersion,toVersion,executedOn,executedBy,result,impactNote,rollbackNote}]` | 404 | — |
| `GET /tickets` | `ticket.read` | `customerId`、`status[]`、`priority[]`、`assigneeOperatorId`、`productId`、`updatedFrom`、`overdueOnly` | `items[{id,ticketNo,subject,customer{...},priority,status,assignee{...},updatedAt,dueAt}]` | 403 | — |
| `POST /tickets` | `ticket.create` | `customerId`、`subject`、`description`、`issueType`、`priority`、`productId?`、`contractId?`、`tenantMappingId?`、`deploymentInstanceId?` | `ticket{status='new'}` | 404、400（引用不属于该客户→`REFERENCE_CUSTOMER_MISMATCH`） | 必填 |
| `GET /tickets/{ticketId}` | `ticket.read` | — | `ticket{...}`、`timeline[]`、`references[]`、`allowedActions[]` | 404 | — |
| `PATCH /tickets/{ticketId}` | `ticket.update` | `subject?`、`description?`、`issueType?`、`priority?`、`version` | `ticket{...}` | 404、409 `CONFLICT` | 可选 |
| `POST /tickets/{ticketId}/assign` | `ticket.assign` | `assigneeOperatorId`、`reason?`、`version` | `ticket{status,assignee}`、`event{id}` | 403、404、409 `STATE_CONFLICT`（`closed` 不可直接分派） | 必填 |
| `POST /tickets/{ticketId}/transition` | `ticket.update`（`start`/`wait`/`resume`/`resolve`）；`ticket.close`（`close`/`reopen`） | `action`、`waitingOn?`、`resolutionSummary?`、`reason?`、`version` | `ticket{status}`、`event{id}` | 403、409 `STATE_CONFLICT`（`details.allowedActions`） | 必填 |
| `GET /tickets/{ticketId}/timeline` | `ticket.read` | `page`/`pageSize` | `items[{id,eventType,fromStatus,toStatus,actor{...},body,waitingOn,createdAt}]`（只增不改） | 404 | — |
| `POST /tickets/{ticketId}/events` | `ticket.update` | `body`（内部说明/沟通摘要） | `event{id,eventType='comment'}` | 404、409 `STATE_CONFLICT`（`closed` 只允许 `reopen`） | 可选 |
| `POST /tickets/{ticketId}/references` | `ticket.update` | `refType`、`refId` | `reference{...}` | 404、409 `CONFLICT`（重复关联）、400（引用不存在） | 可选 |

### 5.9 overview / reports / settings / export

| 端点 | 权限 | 请求关键字段 | 响应关键字段 | 关键错误 | 幂等 |
| --- | --- | --- | --- | --- | --- |
| `GET /overview` | `overview.read` | `windowDays?`（默认取 settings） | `statisticsAt`、`windowDays`、`metrics{activeCustomers,activeContracts,runningTenants,activeEntitlements,expiringEntitlements,openTickets,waitingTickets,failedSyncCommands,pendingReceiptAmount,unreconciledAmount}`、`amounts[{currency,totalReceivable,settledReceivable,overdueReceivable,upcomingReceivable}]`、`partialFailures[]` | 403 | — |
| `GET /reports/receivables` | `receivable.read` | 与 `/receivables` 相同筛选 + `groupBy=customer/contract/dueMonth` | `rows[]`、`totals{...}`、`statisticsAt`、`filtersEcho` | 403、400 | — |
| `GET /reports/expiring-entitlements` | `entitlement.read` | `windowDays`、`subjectType` | `rows[{subjectType,id,customer,product,status,validTo,daysRemaining}]` | 403 | — |
| `GET /reports/tenant-sync-failures` | `tenant.read` | `commandType`、`createdFrom` | `rows[{commandId,mapping,customer,commandType,attemptCount,lastErrorCategory,lastAttemptAt}]` | 403 | — |
| `GET /reports/deployment-versions` | `deployment.read` | `customerId`、`status` | `rows[{version,instanceCount,customers[]}]`、`unknownVersionCount` | 403 | — |
| `GET /settings` | `settings.manage` | — | `settings{overviewExpiryWindowDays,ticketDueHours,exportRetentionDays}`、`updatedBy`、`updatedAt` | 403 | — |
| `PATCH /settings` | `settings.manage` | 任一设置项 | `settings{...}` | 403、400（范围：窗口 1–365 天、工单时限 1–720 小时）[推导] | 必填 |
| `GET /dictionaries` | 任意已认证运营成员 | `code?` | `items[{code,name,items[{value,label,sortOrder,isActive}]}]` | 401/403 | — |
| `POST /dictionaries/{code}/items` | `settings.manage` | `value`、`label`、`sortOrder?` | `item{...}` | 403、409 `CONFLICT` | 必填 |
| `PATCH /dictionary-items/{itemId}` | `settings.manage` | `label?`、`sortOrder?`、`isActive?` | `item{...}` | 403、404 | 可选 |
| `GET /exports` | `export.read` | `exportType`、`status[]`、`requestedBy` | `items[{id,exportNo,exportType,status,rowCount,requestedBy,createdAt,expiresAt}]` | 403 | — |
| `POST /exports` | `export.create` | `exportType`（`receivables`/`receipts`/`contracts`/`customers`/`tickets`）、`filters`（与对应列表端点同构） | 202 `export{id,exportNo,status='queued'}` | 403、400（筛选非法） | 必填 |
| `GET /exports/{exportId}` | `export.read` | — | `export{...}`、`downloadUrl?`（≤5 分钟签名）、`expiresAt` | 404 | — |

---

## 6. 错误码与错误响应结构

### 6.1 响应结构（与 udone 完全一致）

```json
{
  "code": "STATE_CONFLICT",
  "message": "The receipt is not approved",
  "requestId": "5f1c2a7e-...",
  "details": { "reason": "RECEIPT_NOT_APPROVED", "allowedActions": ["approve"] }
}
```

约束 [继承 `middleware/error-handler.ts` + CONTRACTS.md §3.8]：

- 扁平平铺，不套 `error`/`data`；`requestId` 同时写 `X-Request-Id` 响应头。
- `message` 面向运维，前端**不得**解析文案，只按 `code`（必要时叠加 `details.reason`）映射中文。
- `details` 只允许放：字段路径、错误类型、业务原因码、允许动作、冲突对象 ID。**禁止**放金额原文、手机号、token、SQL、堆栈、上游原始 body。
- 未识别异常 → 500 `INTERNAL_ERROR`，message 固定 `An unexpected error occurred`。

### 6.2 复用既有错误码

| code | HTTP | 语义 | 典型 ops 场景 |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | 无/无效 token | 匿名访问任意 ops 端点 |
| `FORBIDDEN` | 403 | 已认证但无权限/成员失效/职责分离冲突 | 租户用户访问 ops；无 `receipt.approve`；登记人自审 |
| `VALIDATION_ERROR` | 400 | 入站校验失败 | 金额为负、日期倒挂、`pageSize` 越界 |
| `NOT_FOUND` | 404 | 目标不存在或无权见（不区分二者） | 访问不存在合同 |
| `CONFLICT` | 409 | 唯一约束/乐观锁/映射冲突 | 合同号重复、`version` 不匹配、租户 ID 已绑定 |
| `OBJECT_REFERENCED` | 409 | 仍被业务事实引用，禁止停用/删除 | 终止客户仍有生效合同；停用套餐仍被草拟合同引用 |
| `RATE_LIMITED` | 429 | 触发限流 | 批量导出/枚举扫描 |
| `INTERNAL_ERROR` | 500 | 未预期错误/出站契约违约 | 响应 schema 不符 |

### 6.3 新增错误码（必须同时改 `packages/contracts/src/errors.ts`）

| code | HTTP | 语义 | `details` 约定 |
| --- | --- | --- | --- |
| `STATE_CONFLICT` | 409 | 当前状态不允许该动作（ops 通用状态机冲突；**不复用** `ORDER_STATE_CONFLICT`） | `reason`（见 §6.4）+ `allowedActions[]`（可选） |
| `IDEMPOTENCY_CONFLICT` | 409 | 同 `Idempotency-Key` 但请求体不同 | 无（不回显首次请求内容） |
| `SYNC_TARGET_UNAVAILABLE` | 502 | `udone` 租户命令端点不可达/超时且结果未知 | `commandId`、`retryable`（命令本身仍以 `pending` 落库，运营侧不报失败） |

**设计说明**：金额类冲突（超额核销、超退）统一走 `STATE_CONFLICT` 而非 422，理由是它们由并发/余额不变量触发，语义是「当前状态不允许」，且前端已有 409 分支处理流程 [继承]。

### 6.4 `details.reason` 词表（按 code 归组，唯一真源）

| code | reason | 触发条件 |
| --- | --- | --- |
| `STATE_CONFLICT` | `APPROVAL_REQUIRED` | 未审批即执行权益变更/开通 |
| `STATE_CONFLICT` | `CONTRACT_IMMUTABLE` | 对 `active`/`expired`/`terminated` 合同做 PATCH |
| `STATE_CONFLICT` | `PERMANENT_ERROR` | 对 `last_error_category='permanent'` 的命令重试 |
| `STATE_CONFLICT` | `HAS_ALLOCATIONS` | 收款仍有有效核销时直接冲正 |
| `STATE_CONFLICT` | `RECEIPT_NOT_APPROVED` | 未审核收款参与核销 |
| `STATE_CONFLICT` | `RECEIPT_EXCEEDED` | 分配总额超过收款可分配净额 |
| `STATE_CONFLICT` | `RECEIVABLE_EXCEEDED` | 单期核销额超过该期应收余额 |
| `STATE_CONFLICT` | `RECEIVABLE_SETTLED` | 对已结清应收展期 |
| `STATE_CONFLICT` | `REFUND_EXCEEDED` | 累计退款超过可退款净额 |
| `STATE_CONFLICT` | `VERSION_MISMATCH` | 部署升级的 `fromVersion` 与实例当前版本不符 |
| `STATE_CONFLICT` | `PACKAGE_RETIRED` | 用已停用套餐发起续约 |
| `STATE_CONFLICT` | `RENEWAL_NOT_DUE` | 原合同未到期且未终止发起续约且未传 `force` |
| `STATE_CONFLICT` | `LAST_ROLE` | 移除运营账号最后一个角色 |
| `STATE_CONFLICT` | `LAST_ADMIN` | 移除最后一个具备 `operator.manage` 的有效账号 |
| `FORBIDDEN` | `OPS_MEMBER_MISSING` | Auth 用户不是运营成员 |
| `FORBIDDEN` | `OPS_MEMBER_INACTIVE` | 运营成员为 `invited`/`disabled` |
| `FORBIDDEN` | `SEGREGATION_OF_DUTY` | 收款登记人自审、变更单申请人自批 |
| `VALIDATION_ERROR` | `PLAN_TOTAL_MISMATCH` | 应收计划合计 ≠ 合同金额 |
| `VALIDATION_ERROR` | `CURRENCY_MISMATCH` | 核销双方币种不一致 |
| `VALIDATION_ERROR` | `CUSTOMER_MISMATCH` | 核销双方客户不一致 |
| `VALIDATION_ERROR` | `REFERENCE_CUSTOMER_MISMATCH` | 工单/部署引用了其他客户的合同、租户或实例 |
| `CONFLICT` | `TENANT_MAPPING_CONFLICT` | 外部租户 ID 已绑定其他客户 |

---

## 7. RLS 与隔离策略

### 7.1 隔离模型

```
Supabase Auth（共享用户空间）
  ├─ 旅行社成员：public.organization_members → current_organization_id() ≠ null
  └─ 运营成员：ops.operators(status='active') → ops.current_operator_id() ≠ null
两套成员关系互不写入、互不推导；一个 auth.users 可以只有其中一种，也可以都没有。
```

| 事实 | 证据 |
| --- | --- |
| 运营端点不读 `X-Organization-ID` | 路由实现只调 `ops.get_current_ops_context()`；ops 请求携带该头时**忽略**（不报错，避免前端复用时误判）[推导] |
| 运营成员判定来自服务端表 | `ops.current_operator_id()` = `select id from ops.operators where user_id = auth.uid() and status='active'` [PRD §4.3] |
| 权限并集来自角色 | `ops.has_permission(p)` = `exists(select 1 from ops.operators o join ops.operator_roles orr ... join ops.role_permissions rp ... where o.user_id=auth.uid() and o.status='active' and rp.permission_code=p)` [PRD §4.2] |
| 租户成员无法获得运营上下文 | `ops.operators` 无对应行 → 函数返回 null → 所有策略为 false |

### 7.2 Schema / grant 设计

```text
CREATE SCHEMA ops;

-- 1) schema 使用权限：anon 一律无
REVOKE ALL ON SCHEMA ops FROM public, anon;
GRANT USAGE ON SCHEMA ops TO authenticated, service_role;

-- 2) 表权限默认全撤，再按需授予
REVOKE ALL ON ALL TABLES IN SCHEMA ops FROM public, anon, authenticated;

-- 3) 直写表只给 SELECT + 白名单列；状态/金额/快照列不在白名单内
GRANT SELECT ON ops.customers TO authenticated;
GRANT INSERT (name, unified_social_credit_code, region_code, owner_operator_id,
              source_note, internal_note, version, created_by)
  ON ops.customers TO authenticated;
GRANT UPDATE (name, unified_social_credit_code, region_code, owner_operator_id,
              source_note, internal_note, version, updated_by, updated_at)
  ON ops.customers TO authenticated;              -- status 列不在其中：只能经 transition RPC

-- 4) 状态机/账务/命令表：只读，写入只经 SECURITY DEFINER RPC
GRANT SELECT ON ops.contracts, ops.receivables, ops.receipts,
                ops.tenant_commands, ops.tickets TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON ops.contracts, ops.receivables, ops.receipts,
                ops.tenant_commands, ops.ticket_events FROM authenticated;

-- 5) 追加式表：SELECT only；INSERT 由 RPC 以 owner 权限完成
GRANT SELECT ON ops.audit_events, ops.entitlement_snapshots,
                ops.receipt_allocations, ops.ticket_events TO authenticated;

-- 6) 全表启用 RLS，无策略即拒绝
ALTER TABLE ops.customers ENABLE ROW LEVEL SECURITY;
```

**暴露决策**：把 `ops` 加入 `supabase/config.toml` 的 `[api] schemas`（当前为 `["public","graphql_public"]`），并在 Worker 的 PostgREST 调用中带 `Accept-Profile: ops` / `Content-Profile: ops`。

| 决策点 | 结论 | 理由 |
| --- | --- | --- |
| 是否暴露 ops 到 Data API | 是（显式加入暴露清单） | PRD §9.2 允许「显式配置暴露清单、grants、每张表 RLS」；Worker 以**用户令牌**访问，RLS 才真正生效 [PRD §10.2「RLS 与 API 权限双重执行」] |
| 为何不用 service_role 读 ops | 禁止在请求路径使用 service_role 访问 ops 表 | service_role 绕过 RLS，会让「双重执行」退化为单层；service_role 仅限 `auth.admin` 邀请/禁用账号、`idempotency_records` 读写与定时任务 [PRD §9.2]「浏览器不得携带 service role」[继承] |
| anon 能力 | 无 schema USAGE、无表权限、无策略 | 匿名请求在 Postgres 层即失败，而不是依赖 Worker 提前拦截 |
| 列级控制 | **不**对敏感列（`phone`/`email`/`unified_social_credit_code`）做接收窄，掩码在 API 层按 `customer.sensitive.read` 决定 | (1) 浏览器不含 anon key、不直连 Data API（`admin` 前端只调 Hono），DB 列权限防不住持有运营 token 的合法用户，只能防未授权角色；(2) `authenticated` 是统一角色，列权限无法按动作细分 [继承 `20261029000001_customer_domain.sql` 注释的同一限制]；(3) 因此「无敏感权限看不到原值」必须由 API DTO 层证明（见 §7.4 P6） |

> 说明：由于 `authenticated` 是唯一数据库角色，**动作级差异只能由 RLS 谓词（`has_permission`）与 RPC 内部校验共同表达**；列级敏感字段收敛到 API 响应组装。此限制与 udone 已知限制同源，必须在测试中显式覆盖。

### 7.3 表分类与策略矩阵

| 类别 | 表 | SELECT 策略 | 写入路径 |
| --- | --- | --- | --- |
| A1 直写主数据（非状态、非金额、非快照列） | `customers`（`status` 除外）、`customer_contacts`、`products`（`lifecycle_status` 除外）、`product_sales_modes`、`feature_definitions`（`feature_key` 除外）、`deployment_instances`（`status`/`current_version` 除外）、`tickets`（`status`/`assignee_operator_id`/`closed_at`/`reopen_count` 除外）、`dictionaries`、`dictionary_items` | `ops.has_permission('<domain>.read')` | `authenticated` 直写**白名单列** + RLS 写策略（`WITH CHECK` 同时校验动作与 `current_operator_id()`） |
| A2 状态机/聚合（只能经 RPC） | `packages`、`package_features`、`package_price_versions`、`contracts`、`contract_items`、`contract_versions`、`contract_amendments`、`contract_attachments`、`receivables`、`receivable_extensions`、`receipts`、`refunds`、`subscriptions`、`private_licenses`、`entitlement_change_requests`、`tenant_mappings`、`tenant_commands`、`operators`、`roles`、`role_permissions`、`operator_roles`、`settings`、`exports` | 对应域 `.read`（`settings` 需 `settings.manage`；`exports` 需 `export.read`） | 无 `INSERT/UPDATE/DELETE` 授权；写入只经 `SECURITY DEFINER` RPC，函数内二次校验权限、版本与状态机 |
| B 追加不可变 | `receipt_allocations`、`receipt_allocation_reversals`、`entitlement_snapshots`、`entitlement_snapshot_lines`、`tenant_command_attempts`、`deployment_version_records`、`ticket_events`、`ticket_references`、`audit_events` | 对应域 `.read`（`audit_events` 需 `audit.read`） | 仅 `SELECT`；`INSERT` 只由 RPC（owner 权限）完成，永久无 `UPDATE/DELETE` |
| C 系统内部 | `idempotency_records` | `authenticated` **零权限** | 仅 `service_role`（幂等中间件与定时清理） |

**统一策略骨架（示例，所有 A1 表同构）**

```text
CREATE POLICY customers_select_reader ON ops.customers
FOR SELECT TO authenticated
USING ( (SELECT ops.current_operator_id()) IS NOT NULL
        AND (SELECT ops.has_permission('customer.read')) );

CREATE POLICY customers_update_writer ON ops.customers
FOR UPDATE TO authenticated
USING ( (SELECT ops.current_operator_id()) IS NOT NULL
        AND (SELECT ops.has_permission('customer.write')) )
WITH CHECK ( (SELECT ops.current_operator_id()) IS NOT NULL
             AND (SELECT ops.has_permission('customer.write')) );
```

**A2 类 RPC 的强制形态**（每个写用例一个函数，禁止通用 `patch_*`）

```text
CREATE OR REPLACE FUNCTION ops.transition_contract(
  requested_contract_id uuid, requested_action text,
  requested_version integer, requested_reason text DEFAULT NULL
) RETURNS TABLE (contract_id uuid, new_status text, version_no integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$ ... $$;

REVOKE ALL ON FUNCTION ops.transition_contract(uuid, text, integer, text) FROM public, anon;
GRANT EXECUTE ON FUNCTION ops.transition_contract(uuid, text, integer, text) TO authenticated;
```

函数体必须：`IF ops.current_operator_id() IS NULL THEN RAISE 42501` → `IF NOT ops.has_permission('contract.approve') THEN RAISE 42501` → `SELECT ... FOR UPDATE` → 版本比对 → 状态机 `CASE` 判定 → 更新 + 写 `ops.audit_events`（同一事务）。

**禁止的模式**

- 禁止 `FOR ALL` 策略（`udone` 已因 `FOR ALL` 让范围检查失效而拆分策略，见 `20261029000003_finance_scope.sql` 注释）[继承]。
- 禁止在策略里只写 `USING (true)` 或只写 `current_operator_id() IS NOT NULL` 而不校验动作。
- 禁止把 `status`、`amount`、`allocated_amount`、`sync_version`、`content_hash` 放进任何 `GRANT UPDATE (...)` 列清单。
- 禁止 `SECURITY DEFINER` 函数省略 `search_path = ''` 与 `REVOKE EXECUTE FROM public, anon` [继承]。
- 禁止跨 schema 引用 `public.*` 表的 SQL 出现在 ops 函数体内（唯一例外：`auth.users` 外键与审计 actor）。

### 7.4 必须证明的拒绝路径（pgTAP / 集成测试清单）

| # | 层级 | 身份 | 操作 | 期望 |
| --- | --- | --- | --- | --- |
| P1 | RLS | `anon` | `select * from ops.customers` | 失败（无 schema USAGE / 无表权限） |
| P2 | RLS | 有效旅行社成员（`organization_members.status='active'`） | `select * from ops.customers` | 失败或 0 行（无 `ops.operators` 行 → 策略 false） |
| P3 | RLS | 有效旅行社成员 | `insert into ops.customers (name, ...) values (...)` | 失败（有列级 INSERT 授权但 `WITH CHECK` 为 false） |
| P4 | RLS | `status='invited'` 或 `'disabled'` 的运营成员 | `select * from ops.contracts` | 0 行 |
| P5 | RLS | `status='active'` 但无 `receivable.read` 的运营成员 | `select * from ops.receipts` | 0 行 |
| P6 | API | 有 `customer.read`、无 `customer.sensitive.read` 的运营成员 | `GET /customers/{id}/contacts` | 响应中**不存在** `phone`/`email` 键（只有 `phoneMasked`/`emailMasked`） |
| P7 | RLS | 运营成员 | `update ops.audit_events set action='x'` | 失败（无 UPDATE 授权） |
| P8 | RLS | 运营成员 | `delete from ops.receipt_allocations` | 失败（无 DELETE 授权） |
| P9 | RLS | 运营成员（任意角色） | `select * from public.orders` / `public.customers` / `public.order_receivables` | 0 行（无 `organization_members` 行 → `current_organization_id()` 为 null） |
| P10 | RLS | 运营成员 | 调用 `public.get_current_auth_context()` | 0 行（不得借用租户上下文） |
| P11 | API | 旅行社管理员（有 `member.manage`） | 调用任意 ops 端点 | 403 `FORBIDDEN` |
| P12 | API | 无 token | 任意 ops 端点 | 401 `AUTH_REQUIRED` |
| P13 | RLS | 有 `customer.write` 的运营成员 | `update ops.customers set status='terminated' where id=...` | 失败（`status` 不在 UPDATE 列白名单，只能经 transition RPC） |

> P9 是「运营身份不能读旅行社业务明细」的核心证明：它由**租户侧既有 RLS** 提供，不需要在 ops 侧加任何代码；测试只需断言运营身份在 public 业务表上的可见行数为 0，且运营 API 不提供任何透传租户明细的端点 [PRD §11.1 第 6 条]。

---

## 8. 契约交付顺序建议

依赖关系：`B0 → B1 → B2 → B3 → B4 → B5 → B6`；B3 与 B4 可并行（B4 只依赖 B2），但**迁移文件必须由同一会话串行追加**，不得两人同时改 `udone/supabase/migrations/`。

| 批次 | 内容 | 前端可开始条件 | 前端可并行的部分 |
| --- | --- | --- | --- |
| **B0** | 契约包骨架（`packages/contracts/src/ops/**` + `OPS_ROUTES` 注册 + 三个新错误码）、`ops` schema 引导迁移、`ops.operators/roles/permissions/role_permissions/operator_roles`、`ops.current_operator_id()` / `ops.has_permission()` / `ops.get_current_ops_context()`、`requireOpsAuth` 中间件、`GET /meta`、`GET /session`、账号与角色管理端点、审计表与写入函数 | `GET /meta`、`GET /session` 在 staging 通过，且租户用户/匿名拒绝用例通过 | 登录改造、权限码驱动菜单、拒绝页、adapter 与错误码映射（可先用 `contracts` 包类型做编译期对齐，不用 mock 数据充当业务） |
| **B1** | customer 域 + catalog 域（表、RPC、端点、RLS、pgTAP） | B0 完成 | 客户列表/详情/联系人、产品与套餐页（接口未上线前用 typed fixture 仅填充 UI 状态） |
| **B2** | contract 域（合同、条目、版本、变更单、续约、附件、权益预览） | B1 完成（客户与目录是外键前置） | 合同列表/详情/草拟/生效确认弹窗 |
| **B3** | billing 域（应收、收款、核销、核销撤销、退款、展期、账款报表） | B2 完成（需要生效合同产生应收） | 账款页、收款录入、核销分配、退款登记 |
| **B4** | entitlement 域 + tenant-integration 域（订阅、授权、快照、变更申请、租户映射、命令、重试） | B2 完成；B3 可并行（授权不因未结清自动阻塞，但需独立审批）[Task 6 负责人默认规则] | 权益差异预览、审批后执行、同步状态与重试 |
| **B5** | deployment 域 + support 域 | B4 完成（工单需关联租户命令与授权变更） | 部署台账、升级记录、工单看板与时间线 |
| **B6** | overview、reports、settings、dictionaries、audit 查询、exports | B3–B5 全部完成（指标依赖全部域） | 总览卡片与下钻、报表筛选、导出任务列表 |

**关键握手规则**

1. 每批结束交付：契约文件路径 + 提交号 + 迁移版本号 + 「允许/拒绝」测试清单 + 虚构 fixture（≥3 客户、≥5 合同、≥10 应收、≥5 收款、≥2 租户命令失败态）。
2. 前端不得在 B1 之前开始任何真实数据页面；B0 之前只允许搭建 shell、路由、权限呈现与 adapter。
3. 契约变更（字段增删/错误码/状态值）必须先改本文件与 `packages/contracts`，再通知前端升级 client，禁止前端「按字段猜」。
4. 迁移编号必须连续且唯一（当前存在重复版本号问题，见 `admin/.harness/docs/exec-plans/...implementation.md` Task 9 状态记录），新批次开始前先确认最新编号。

---

## 9. 后端实施任务书（可直接派发给 udone 实现会话）

> 每项含**交付物**与**验收断言**；验收断言必须包含至少一条拒绝路径。所有金额、状态、幂等断言都要求真实 PostgreSQL/pgTAP 或 API 集成测试，不以 mock 代替。

### T-01 契约包与路由骨架

**交付物**：`packages/contracts/src/ops/{permissions,errors,routes,meta,identity,...}.ts`；`OPS_ROUTES` 注册进路由一致性测试（与既有 `ROUTES` 合并对账）；`apps/api/src/modules/ops/**` 目录与 `index.ts` 挂载；`GET /api/v1/ops/meta`。 **验收断言**：

- 允许：带有效运营 token 请求 `/meta` 返回 `contractVersion`、`timezone`。
- 拒绝：`route-parity.test.ts` 在删除任一 ops 路由挂载或清单项时失败。
- 拒绝：`OPS_ROUTES` 中出现不在 `/api/v1/ops` 前缀下的路径时测试失败。
- 拒绝：`ops.permissions` seed 与 `permissions.ts` 常量不一致时单测失败。

### T-02 迁移引导与 RLS 帮助函数

**交付物**：`supabase/migrations/<next>_ops_schema_bootstrap.sql`：`CREATE SCHEMA ops`、schema grant/revoke、`ops.current_operator_id()`、`ops.has_permission(text)`、`ops.get_current_ops_context()`、`ops.require_permission(text)`、`ops.write_audit(...)`；`config.toml` 暴露 `ops`。 **验收断言**：

- 允许：活跃运营成员调用 `ops.get_current_ops_context()` 返回 `operatorId/roles/permissions`。
- 拒绝：`invited`/`disabled` 成员返回 0 行。
- 拒绝：旅行社成员调用返回 0 行（P2/P10）。
- 拒绝：`anon` 无 schema USAGE（P1）。
- 断言：所有函数 `search_path=''` 且 `EXECUTE` 未授予 `public`/`anon`。

### T-03 运营身份与账号管理

**交付物**：`ops.operators`、`roles`、`permissions`、`role_permissions`、`operator_roles`、`audit_events`；端点 `GET /session`、`GET/POST/PATCH /operators*`、`GET/POST/PATCH /roles*`、`GET /permissions`、`GET /audit-events`；邀请走 `auth.admin`（service_role）。 **验收断言**：

- 允许：平台管理员邀请新邮箱 → `operators.status='invited'`，审计含 `operator.invited`。
- 拒绝：无 `operator.manage` 调用邀请 → 403，且 `ops.operators` 行数不变。
- 拒绝：移除某账号最后一个角色 → 409 `STATE_CONFLICT`（`LAST_ROLE`）。
- 拒绝：把自己禁用后立即用旧 token 调用 `PATCH /customers/{id}` → 403（不是 401，token 仍有效但成员失效）。
- 拒绝：普通运营成员 `PATCH /roles/{id}` → 403。
- 断言：角色变更审计含 `before_summary`/`after_summary` 的权限数组。

### T-04 客户与联系人

**交付物**：`ops.customers`、`customer_contacts`；`POST /customers`（含重复提示）、`duplicate-check`、`GET/PATCH`、`transition`、`overview`（聚合摘要）、联系人 CRUD。 **验收断言**：

- 允许：创建客户返回 `duplicateHints` 而非报错（同名/同 USCC 不阻断）。
- 拒绝：`customer_no` 重复 → 409 `CONFLICT`。
- 拒绝：终止仍有生效合同的客户 → 409 `OBJECT_REFERENCED`。
- 拒绝：无 `customer.sensitive.read` 的响应中**不含** `phone`/`email` 原值字段（键不存在，而不是 null）。
- 拒绝：PATCH 带过期 `version` → 409 `CONFLICT`。
- 断言：`GET /customers/{id}/overview` 的计数与各域明细列表 `total` 一致（同客户、同筛选）。

### T-05 产品、套餐与价格版本

**交付物**：catalog 六表 + 全部 catalog 端点。 **验收断言**：

- 允许：新增价格版本后，历史合同条目 `unit_price`/`amount`/快照不变。
- 拒绝：`sales_mode` 未在 `product_sales_modes.is_enabled` 中时创建套餐或合同时 → 400。
- 拒绝：停用仍被 `draft`/`reviewing` 合同引用的套餐 → 409 `OBJECT_REFERENCED`。
- 拒绝：`PATCH /features/{key}` 试图改 `featureKey` → 400（schema 层拒绝未知字段）。
- 断言：`contracts.total_amount` 始终等于 `sum(contract_items.amount)`（触发器或 RPC 保证，抽查 20 条）。

### T-06 合同生命周期与版本快照

**交付物**：contract 五表 + 端点（列表/详情/草拟/transition/versions/amendments/renewals/preview/attachments）。 **验收断言**：

- 允许：`reviewing → signed → active` 后生成 `contract_versions` 第 1 版，`snapshot` 含条目与权益行。
- 拒绝：`draft` 直接 `activate` → 409 `STATE_CONFLICT`。
- 拒绝：`active` 合同通过 PATCH 改 `total_amount` → 409 `STATE_CONFLICT`（`CONTRACT_IMMUTABLE`）。
- 拒绝：无 `contract.approve` 执行 `sign` → 403。
- 拒绝：变更单 `approved_by = requested_by`（同人）→ 409/403（服务端强制）。
- 断言：续约合同 `renewed_from_contract_id` 指向原合同，原合同状态与版本不变。

### T-07 应收计划与展期

**交付物**：`receivables`、`receivable_extensions` + 端点。 **验收断言**：

- 允许：按付款条款生成 3 期，`sum(amount)` 等于合同额。
- 拒绝：期数合计 ≠ 合同额 → 400 `PLAN_TOTAL_MISMATCH`。
- 拒绝：对已结清应收展期 → 409 `STATE_CONFLICT`（`RECEIVABLE_SETTLED`）。
- 断言：展期后 `due_date` 为新值，`receivable_extensions.previous_due_date` 保留原值，累计展期次数可查。

### T-08 收款、审核、核销与并发

**交付物**：`receipts`、`receipt_allocations`、`receipt_allocation_reversals`、`refunds` + RPC `ops.allocate_receipt(...)`、`ops.reverse_allocation(...)`、`ops.reverse_receipt(...)`、`ops.register_refund(...)` + 端点；DB 幂等表。 **验收断言**：

- 允许：`recorded → pending_reconcile`（他人审核）→ 分配 2 条应收 → `reconciled`，实收统计增加。
- 拒绝：登记人自审 → 403 `FORBIDDEN`（`SEGREGATION_OF_DUTY`）。
- 拒绝：未审核收款直接核销 → 409 `STATE_CONFLICT`（`RECEIPT_NOT_APPROVED`）。
- 拒绝：分配总额 > 收款额 → 409 `STATE_CONFLICT`（`RECEIPT_EXCEEDED`），`receipts.allocated_amount` 不变。
- 拒绝：两个并发事务各核销 60% 到同一条应收（总额 100%）→ 恰好一个成功，另一个 409，`allocated_amount <= amount`。
- 拒绝：跨客户/跨币种核销 → 400（复合外键/服务校验）。
- 拒绝：同 `Idempotency-Key` 重复提交 → 返回首次结果 + `Idempotent-Replay: true`，`receipts` 只有一行；同 key 不同 body → 409 `IDEMPOTENCY_CONFLICT`。
- 拒绝：撤销核销不传 `reason` → 400。
- 断言：撤销核销后原 `receipt_allocations` 行仍在，`receipt_allocation_reversals` 新增一行，余额恢复。

### T-09 订阅、授权与权益快照

**交付物**：entitlement 五表 + 端点。 **验收断言**：

- 允许：合同生效 → 草案订阅 → 提交 → 他人审批 → 快照落地（不可变）。
- 拒绝：`draft` 状态执行下发 → 409 `STATE_CONFLICT`（`APPROVAL_REQUIRED`）。
- 拒绝：`UPDATE ops.entitlement_snapshots SET ...` 由 `authenticated` 执行 → 权限错误。
- 断言：修改套餐价格/权益后，既有快照行 `content_hash` 与 `quota_value` 不变。
- 拒绝：永久授权（`license_mode='perpetual'`）带 `valid_to` → 400。

### T-10 租户映射与跨系统命令

**交付物**：`tenant_mappings`、`tenant_commands`、`tenant_command_attempts` + 端点 + `udone` 内部接收端点的客户端适配层（含超时与结果查询）。 **验收断言**：

- 允许：`provision` 命令 → 202 → 轮询到 `succeeded`，`mapping.sync_version` +1。
- 拒绝：同一 `udone_organization_id` 绑定第二个客户 → 409 `CONFLICT`（`TENANT_MAPPING_CONFLICT`）。
- 拒绝：重复 `Idempotency-Key` 提交开通 → 只产生一条命令，远端只开通一次。
- 拒绝：`expected_sync_version` 落后 → 409 `STATE_CONFLICT`。
- 拒绝：`last_error_category='permanent'` 的命令重试 → 409（`PERMANENT_ERROR`）。
- 拒绝：`succeeded` 命令取消 → 409；任何命令 DELETE → 权限错误。
- 断言：超时场景命令保持 `pending` 且 `attempts.outcome='timeout'`，运营侧不出现「已成功」。

### T-11 私有化部署台账

**交付物**：`deployment_instances`、`deployment_version_records` + 端点。 **验收断言**：

- 允许：登记 `1.4.0 → 1.5.0` 成功，`current_version` 更新，历史保留。
- 拒绝：`from_version` 与当前版本不符 → 409 `STATE_CONFLICT`（`VERSION_MISMATCH`）。
- 拒绝：`information_schema.columns` 中断言不存在 `ssh_*`/`*password*`/`connection_string` 列（白名单测试）。
- 拒绝：`ticket` 关联其他客户的部署实例 → 400（`REFERENCE_CUSTOMER_MISMATCH`）。

### T-12 售后工单与时间线

**交付物**：`tickets`、`ticket_events`、`ticket_references` + 端点。 **验收断言**：

- 允许：`new → assigned → in_progress → waiting(waitingOn 必填) → in_progress → resolved → closed → reopen`，时间线 8+ 条事件。
- 拒绝：`waiting` 不传 `waitingOn` → 400。
- 拒绝：`closed` 直接 `assign` → 409 `STATE_CONFLICT`（返回 `allowedActions`）。
- 拒绝：`UPDATE ops.ticket_events` / `DELETE` → 权限错误。
- 断言：售后角色响应中无收款金额字段（DTO 层面不存在该键）。

### T-13 总览、报表与口径一致

**交付物**：`GET /overview` + 4 个报表端点 + settings/dictionaries + exports（异步任务 + 签名下载 + 审计）。 **验收断言**：

- 允许：`overview.amounts[currency=CNY].overdueReceivable` 与 `/receivables?status=overdue` 的 `summary.overdueAmount` 完全相等（同币种、同统计时刻）。
- 拒绝：无 `receivable.read` 的用户请求 `/reports/receivables` → 403；`/overview` 中不含其无权指标（返回 `restrictedMetrics[]` 而非 0 冒充）。
- 拒绝：无 `export.create` 创建导出 → 403；导出审计含 `filters` 与 `rowCount`。
- 断言：100k 应收 / 10k 客户合成数据下列表 p95 < 800ms、总览 p95 < 1.5s（记录执行计划与索引命中）[PRD §10.1]。
- 断言：导出下载 URL 有效期 ≤ 5 分钟且需 `export.read`。

### T-14 跨域拒绝与回归

**交付物**：`supabase/tests/ops_*.sql`（P1–P13）、API 集成测试（正/反向）、`admin` 侧契约差异检查脚本。 **验收断言**：

- 断言：P1–P13 全部按 §7.4 表格结果。
- 断言：`ops` schema 不出现在 `anon` 可访问对象中（`has_schema_privilege('anon','ops','USAGE') = false`）。
- 断言：空库全量重放迁移成功且迁移版本号无重复。
- 拒绝：前端 `contractVersion` 与 `/meta` 不匹配时不渲染业务页，显示升级提示（不静默回退 mock）。

---

## 10. 指标口径映射（实现对照）

| 指标 | 口径（SQL 层实现要点） | 来源 |
| --- | --- | --- |
| 有效软件客户 | `customers.status='active'` 且存在 `contracts.status IN ('active','signed')` 或有效订阅/授权 | [PRD §12] |
| SaaS 运行租户 | `tenant_mappings` 中最新命令 `succeeded` 且 `last_known_state='active'` 的唯一映射数（按 `udone_organization_id` 去重） | [PRD §12] |
| 合同待收金额 | `receivables.status IN ('upcoming','partial','overdue')` 的 `amount - net` 之和，仅限 `contracts.status IN ('signed','active')` | [PRD §12] |
| 逾期应收金额 | `due_date < today` 且 `net < amount` 之和，扣除已冲销部分 | [PRD §12] |
| 临期权益 | `subscriptions`/`private_licenses` 中 `status='active'` 且 `valid_to` 落在窗口内（`settings.overview.expiryWindowDays`，默认 30） | [PRD §12] [PRD §6.1] |
| 开放工单 | `tickets.status NOT IN ('resolved','closed')`，`waiting` 单独分组 | [PRD §12] |
| 租户同步失败 | 每个映射的最新命令 `status='failed'` 且其后无 `succeeded` 重试 | [PRD §12] |
| 私有部署版本分布 | 有效实例（`status IN ('active','maintenance')`）的 `current_version` 分组，缺失版本单列 `unknown` | [PRD §12] |
| 实收金额 | `receipts.status='reconciled'` 且已审核，按 `receipt_allocations` 净额（扣 `reversals`）汇总；待审核/待核销单独列 | [PRD §6.1] |

**统一口径载体**：所有指标、报表、导出必须调用同一组 SQL 视图/函数（`ops.v_receivable_status`、`ops.fn_overview_metrics(...)`），禁止前端或报表各自实现 [PRD §6.1]「图表和列表使用同一查询口径」[PRD §12]。

---

## 11. 不确定性清单（推导，需产品确认）

| # | 问题 | 本文件采用的默认值 | 依据 / 影响 |
| --- | --- | --- | --- |
| U-01 | PRD §6.4 标题为「合同与订单」，但字段只描述合同；是否存在独立「订单」实体？ | **不建独立订单表**：合同即订单，销售项为 `contract_items` | [推导]。若产品确认为两实体，需新增 `ops.orders` 与合同-订单关联，影响台账与账款外键 |
| U-02 | 应收状态同时列 `upcoming` 与 `unpaid`，二者边界未定义 | API 只返回 5 态（`reversed/paid/overdue/partial/upcoming`），`unpaid` 保留不返回 | [推导]。若产品要求「已到期未逾期（宽限期）」语义，需要新增宽限期配置 |
| U-03 | 退款状态机未在 PRD §8 出现 | `recorded → approved / cancelled`，无 `completed`（不调用支付渠道） | [推导]。若需线下退款到账确认，增加 `completed` 与到账凭证 |
| U-04 | 权益变更申请的状态集未定义 | `draft/pending_approval/approved/rejected/executing/executed/failed/cancelled` | [推导]。PRD §8 的六态是**订阅/授权主体**状态，不是申请状态 |
| U-05 | 客户编号/合同号生成规则未定义 | `前缀-YYYY-6 位序列`（`KH-2026-000123`、`HT-2026-000045`），允许空洞 | [推导]。若需人工指定编号，须增加唯一性与审计校验 |
| U-06 | 幂等记录放进程内存还是数据库 | **数据库** `ops.idempotency_records` | [推导]。现有内存实现跨 isolate 失效，无法保护钱款与开通命令 |
| U-07 | 运营端是否需要行级数据范围（`own`/`all`） | **不做行级数据范围**；`ownerOperatorId` 仅为筛选条件 | [推导]。PRD §4 只定义动作权限，未定义数据范围；若需要，按 udone 模式加 `ops_role_data_scopes` |
| U-08 | 运营账号是否可同时拥有多个角色 | 允许，权限取并集 | [推导]。PRD §4.3「至少一个运营角色」暗示可多；若限定单角色，改为 `operators.role_id` |
| U-09 | 哪些动作强制二次认证/MFA | v1 只强制 `reason` + 审计 + 前端确认；`operators.mfa_required` 仅记录策略位 | [推导]。PRD §4.3「后端按权限和策略决定」，具体策略未定；上线前须补 step-up 实现 |
| U-10 | 私有化「部署类型」枚举 | `private` / `dedicated`（托管独享） | [推导]。PRD 只写「部署类型」，未给值域 |
| U-11 | 工单优先级枚举与内部时限口径 | `urgent/high/normal/low`；`due_at` 由 `settings.ticket.dueHours` 按优先级系数计算 | [推导]。PRD 只要求「可配置内部工作时限」，未给值域与系数 |
| U-12 | 非 CNY 币种是否允许 | 允许（ISO-4217），同合同链路强制同币种；总览按币种分组不合并 | [推导]。PRD §2.4 排除「多币种换算与跨境结算」，未禁止外币记账 |
| U-13 | 合同附件存储与上传方式 | Supabase Storage 私有桶 `ops-contracts`，两段式上传（签发 ≤5 分钟上传 URL），下载签名 URL ≤5 分钟 | [推导]。PRD 只要求「安全访问引用，不公开可猜测 URL」 |
| U-14 | 导出是否一律异步 | 一律异步（`queued/running/succeeded/failed/expired`），单文件上限 200k 行 | [推导]。PRD §10.1「大规模导出使用受后台任务」，未给同步阈值 |
| U-15 | 运营成员邀请是否需要邮箱域名白名单 | 不限制域名，仅平台管理员可邀请 | [推导]。PRD 未定义；若需限制，加 `settings` 项与校验 |
| U-16 | 客户「地区」字段口径 | `region_code` 存 GB/T 2260 行政区划码，展示层映射名称 | [推导]。PRD 只写「地区」 |

---

## 附录 A：物理表总览（43 张）

| 域 | 表 | 写入模式 | 可变性 |
| --- | --- | --- | --- |
| customer | `ops.customers` | RPC | 可变（软停用） |
| customer | `ops.customer_contacts` | RPC | 可变（软删除） |
| catalog | `ops.products` | RPC | 可变 |
| catalog | `ops.product_sales_modes` | RPC | 可变 |
| catalog | `ops.packages` | RPC | 可变 |
| catalog | `ops.package_price_versions` | RPC | 不可变 |
| catalog | `ops.feature_definitions` | RPC | 部分可变（`feature_key` 不可变） |
| catalog | `ops.package_features` | RPC | 可变 |
| contract | `ops.contracts` | RPC | 可变（状态机约束） |
| contract | `ops.contract_items` | RPC | 生效后不可变 |
| contract | `ops.contract_versions` | RPC | 不可变 |
| contract | `ops.contract_amendments` | RPC | 状态可变，摘要不可变 |
| contract | `ops.contract_attachments` | RPC | 元数据可变 |
| billing | `ops.receivables` | RPC | 余额列 RPC 维护 |
| billing | `ops.receivable_extensions` | RPC | 不可变 |
| billing | `ops.receipts` | RPC | 状态可变 |
| billing | `ops.receipt_allocations` | RPC | 不可变 |
| billing | `ops.receipt_allocation_reversals` | RPC | 不可变 |
| billing | `ops.refunds` | RPC | 状态可变 |
| entitlement | `ops.subscriptions` | RPC | 状态可变 |
| entitlement | `ops.private_licenses` | RPC | 状态可变 |
| entitlement | `ops.entitlement_snapshots` | RPC | 不可变 |
| entitlement | `ops.entitlement_snapshot_lines` | RPC | 不可变 |
| entitlement | `ops.entitlement_change_requests` | RPC | 状态可变 |
| tenant | `ops.tenant_mappings` | RPC | 状态可变 |
| tenant | `ops.tenant_commands` | RPC（系统更新） | 状态可变，不可删除 |
| tenant | `ops.tenant_command_attempts` | RPC | 不可变 |
| deployment | `ops.deployment_instances` | RPC | 可变 |
| deployment | `ops.deployment_version_records` | RPC | 不可变 |
| support | `ops.tickets` | RPC | 状态可变 |
| support | `ops.ticket_events` | RPC | 不可变 |
| support | `ops.ticket_references` | RPC | 不可变 |
| identity | `ops.operators` | RPC | 状态可变 |
| identity | `ops.roles` | RPC | 可变 |
| identity | `ops.permissions` | 迁移 seed | 只读 |
| identity | `ops.role_permissions` | RPC | 可变（受审计） |
| identity | `ops.operator_roles` | RPC | 可变（受审计） |
| identity | `ops.audit_events` | RPC | 不可变 |
| identity | `ops.idempotency_records` | 中间件/service_role | 不可变（按 TTL 清理） |
| identity | `ops.dictionaries` | RPC | 可变 |
| identity | `ops.dictionary_items` | RPC | 可变 |
| identity | `ops.settings` | RPC | 可变 |
| identity | `ops.exports` | 后台任务 | 状态可变，产物按 TTL 过期 |

## 附录 B：与既有实现的关键差异（供评审确认）

| 项 | 既有 `udone` 做法 | ops 做法 | 原因 |
| --- | --- | --- | --- |
| API 前缀 | `/api/*` 无版本 | `/api/v1/ops/*` | [PRD §9.3] 要求独立版本化命名空间；ops 无历史包袱 |
| 租户标识 | `X-Organization-ID` + JWT `organization_id` | 无租户头，单一运营组织 | [PRD §4.1] 运营端是软件提供方内部单一主体 |
| 身份来源 | `public.organization_members` + `has_permission()` | `ops.operators` + `ops.has_permission()` | [PRD §4.1] 授权域隔离 |
| 审计表 | `public.audit_events`（`organization_id NOT NULL`） | `ops.audit_events`（`actor_operator_id`） | 能复用表结构但无法复用表（列约束不兼容），且跨域写租户表违反 §2.7 |
| 金额 | `numeric(14,2)` + JSON `number` | 相同 | 一致，不引入第二套表示 |
| 幂等 | 进程内存 store | 数据库表 + 业务幂等键 | 内存实现跨实例失效，钱款/开通不可承受 |
| 写入路径 | `authenticated` 直写部分表（含状态列由 RPC 改） | 分两类：A1 表直写白名单列（状态列除外）；A2 表只经 `SECURITY DEFINER` RPC | 状态机、快照、账务、审计必须原子；直写无法保证「不可覆盖」，因此按列/按表区分 |
