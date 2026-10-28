# 旅行社 OMS 技术选型与架构方案

> 状态：已确认，作为开发基线
>
> 确认日期：2026-10-02
>
> 前端组件库调整：2026-10-04
>
> 适用范围：项目复刻的第一版和后续 P0/P1 功能

## 1. 决策结论

项目采用“逻辑前后端分离、初期单 Worker 部署”的架构：

```text
浏览器
  └─ Vue 3 + TypeScript + Vite + Ant Design Vue
       └─ Cloudflare Workers（Hono API）
            ├─ Supabase Auth
            ├─ Supabase PostgreSQL + RLS + RPC/事务函数
            └─ 七牛云对象存储（目标选型；集成暂缓）
```

前端和后端在代码目录、接口契约和职责上分离，但第一阶段不拆成多个微服务。Cloudflare Worker 可以同时承载静态前端资源和 Hono API，减少部署、域名和运维复杂度。

最终语言组合：

- 前端：TypeScript；
- API 后端：TypeScript + Hono；
- 数据库迁移、策略和事务函数：SQL / PL/pgSQL；
- 部署运行时：Cloudflare Workers；
- 对象存储目标：七牛云；当前没有已确认的前端持久化上传/下载流程，因此暂不开发存储集成。

## 2. 选型依据

### 2.1 现有部署约束

- 前期不购买独立服务器；
- 公司多人通过公网 HTTPS 使用；
- 使用 Cloudflare + Supabase 的免费试运行方案；
- Supabase 负责 PostgreSQL、Auth 和 RLS；
- 七牛云是对象存储目标；接入时机由明确的产品上传/下载流程触发；
- 既有服务器只承担每日健康检查和加密备份任务；
- 方案必须保留以后迁移到独立服务器或国内云的可能性。

### 2.2 业务约束

- 订单、游客、供应商、财务项目、收付款和审批存在跨表事务；
- 角色、组织和租户隔离必须在 API 和数据库两层执行；
- 财务写操作需要审计、幂等和可追踪错误；
- 页面不能直接暴露 service role 或绕过业务命令写入财务数据；
- 复刻目标是旅行 OMS，不是复制通用 ERP 的页面和数据模型。

## 3. 开源项目调查结论

### 3.1 ERPNext/Frappe

ERPNext 覆盖会计、订单、客户、供应商和项目，Frappe 使用 Python/JavaScript，并提供 Vue UI。官方自托管路径依赖 Docker、Bench 和 MariaDB，ERPNext 仓库许可证为 GPL-3.0。

结论：适合作为流程和字段参考，不作为本项目代码基座。它的运行方式、数据模型和许可证边界都与 Cloudflare Workers + Supabase 方案不一致。

来源：[ERPNext 官方仓库](https://github.com/frappe/erpnext)

### 3.2 Odoo

Odoo 覆盖 CRM、销售、采购、库存、会计、多公司和多级权限，主要使用 Python/PostgreSQL，核心许可证为 LGPLv3。

结论：适合作为财务、审批和权限能力的对照产品。直接改造会引入完整 Odoo 服务和升级维护成本，不能作为当前免费边缘部署基座。

来源：[Odoo 官方仓库](https://github.com/odoo/odoo)

### 3.3 Dolibarr

Dolibarr 更轻量，覆盖联系人、报价、订单、发票、库存和项目，采用 PHP 和关系数据库。

结论：可作为轻量 ERP 流程参考，但仍需要自托管常驻服务，且旅行 OMS 的审批、游客和结算模型需要另行开发。

来源：[Dolibarr 官方仓库](https://github.com/Dolibarr/dolibarr)

### 3.4 Directus 和低代码后台

Directus 可以为 PostgreSQL 提供通用管理界面和 API，但其自托管官方路径依赖 Node.js/Docker，且通用集合管理不能替代订单状态机、财务事务和领域权限。

结论：不作为业务后台基座；未来可以在受控环境中作为内部数据运维工具评估。

来源：[Directus 自托管文档](https://docs.directus.io/self-hosted/docker-guide)

## 4. 前端选型

### 4.1 最终选择

- Vue 3；
- Vite；
- TypeScript；
- Ant Design Vue；
- Pinia；
- Vue Router；
- TanStack Query for Vue 或等价的请求缓存层；
- ECharts 用于经营报表和统计图。

当前状态（2026-10-05）：Vue 3、Vite、TypeScript、Ant Design Vue 与 Vue Router 已用于应用；Pinia 暂缓，当前 auth 状态由 `apps/web/src/stores/auth.ts` 中的 Vue composable 承载，待跨视图共享状态出现具体复杂度再引入；TanStack Query for Vue 暂缓，当前未引入服务端查询缓存/失效层，等具体验收需求出现后评估。两项都不是已安装依赖或当前开发门禁。

Ant Design Vue 作为当前 Vue 后台组件库，用于表格、表单、上传、审批和财务页面。Vben Admin 只借鉴布局、路由权限和中后台组织方式，不直接把整个模板当作业务基座，以保留业务页面的改造自由度。

来源：[Ant Design Vue 官方文档](https://www.antdv.com/)、[Vben Admin 官方仓库](https://github.com/vbenjs/vue-vben-admin)

### 4.2 后续智能体界面

当前项目使用 Vue 3，因此未来引入 AI 智能体对话界面时，计划评估并复用 [`ant-design-x-vue`](https://github.com/wzc520pyfm/ant-design-x-vue) 的气泡消息、会话列表、输入框等组件。它是社区维护的 Vue 实现，并非 Ant Group 官方 Vue 版 Ant Design X；Ant Group 官方 Ant Design X 目前面向 React。该 AI 组件库不在当前依赖中，待智能体功能立项时再核验维护状态、许可、接口和后端流式协议。

来源：[Ant Design X 官方 FAQ](https://ant-design-x.antgroup.com/docs/react/faq-cn)、[ant-design-x-vue 仓库](https://github.com/wzc520pyfm/ant-design-x-vue)

### 4.3 未选择 React + Refine 的原因

React + Refine + Ant Design 是可行备选。Refine 官方提供 Supabase data provider、认证适配器和 REST provider，适合快速生成 CRUD。

但本项目的核心工作不是通用 CRUD，而是订单命令、审批、财务事务、结算和审计。Refine 的抽象层不能替代这些领域逻辑，反而会增加统一设计和调试成本。因此暂不采用，但保留作为后续独立前端重构的备选。

来源：[Refine 数据提供器](https://refine.dev/core/docs/data/data-provider/)、[Refine Supabase 集成](https://refine.dev/core/docs/data/packages/supabase/)

## 5. 后端选型

### 5.1 API 语言和框架

API 使用 TypeScript + Hono，运行于 Cloudflare Workers。

选择理由：

- TypeScript 与 Vue 前端共享 DTO、错误码、权限常量和枚举；
- Hono 基于 Fetch/Web 标准，原生适配 Workers；
- Cloudflare 官方提供 Hono + SPA 的全栈部署路径；
- 同一套 API 可以在本地 Worker 模拟器中运行，也能迁移到 Node/Bun 等兼容运行时；
- 不需要维护常驻 Node.js、Python 或 Java 服务器。

来源：[Cloudflare Hono 官方指南](https://developers.cloudflare.com/workers/framework-guides/web-apps/more-web-frameworks/hono/)

### 5.2 为什么当前不使用 Go

Go 可以编译为 Wasm 在 Workers 上运行，也可以放入 Cloudflare Containers，但两者都不是当前免费方案的最佳路径：

- Wasm 需要额外适配，Cloudflare 绑定、数据库驱动和调试体验不如 TypeScript；
- Cloudflare Containers 需要 Workers Paid 计划；
- 独立 Go 服务需要额外服务器或容器运行环境。

因此 Go 保留为未来批量报表、文件处理或独立计算服务的候选，不作为第一版主 API 语言。

来源：[Cloudflare Workers 语言支持](https://developers.cloudflare.com/workers/languages/)、[Cloudflare Containers](https://developers.cloudflare.com/containers/)

## 6. 前后端职责边界

### 6.1 前端负责

- 页面、导航、表格、表单和交互反馈；
- 展示权限控制和字段级可见性；
- 基础输入校验和导入文件预检；
- 调用 API 命令和查询；
- 不保存 service role 密钥；
- 不直接修改财务核心表。

### 6.2 Hono API 负责

- 解析 Supabase Auth JWT；
- 加载用户、组织、角色和租户上下文；
- 执行接口级权限和状态机校验；
- 处理订单、审批、收付款、结算等业务命令；
- 调用数据库事务/RPC；
- 在对象存储集成任务获批后，通过服务端适配层处理上传/下载授权；当前不实现文件 API 或签名 URL；
- 统一错误码、请求 ID、幂等键和审计事件；
- 对外部系统和 AI 能力提供受控适配层。

### 6.3 Supabase 负责

- 用户认证和会话；
- PostgreSQL 数据存储；
- RLS 行级隔离；
- 事务函数和数据库约束；
- 必要的实时订阅能力。

### 6.4 身份、恢复与会话决策（Task 3）

- Supabase Auth 的验证邮箱是全局登录标识；不创建 username 字段/映射。profile.display_name 仅用于展示，邀请以邮箱寻址。
- 密码恢复使用 Auth recovery email；前端以相同确认响应处理存在与不存在的邮箱。密码更新由 Auth 管理，并依 provider 行为撤销 refresh session；Worker 每个受保护请求重新核对组织成员状态，因此停用成员立即失去 API 权限。无状态 access JWT 的已签发副本在其有效期结束前可能仍可经 Auth 验证，不把 refresh 撤销描述成即时清除所有 JWT。
- 登录错误保持通用，不实现自定义账户锁定；不把密码或 token 写入应用日志。失败登录事件/次数依 Supabase Auth 审计能力记录。
- 部署配置 Supabase Auth 的 IP 限流和 CAPTCHA。前端 Auth 请求直达 Supabase，以免代理破坏基于客户端 IP 的限流语义；CAPTCHA 使用 Cloudflare Turnstile，部署配置 `VITE_SUPABASE_CAPTCHA_SITE_KEY` 后由登录/恢复表单传入一次性 CAPTCHA token。邀请/恢复邮件重定向须配置允许的应用 URL 与 `APP_BASE_URL`。

依据：[Supabase Password-based Auth](https://supabase.com/docs/guides/auth/passwords)、[Auth Rate Limits](https://supabase.com/docs/guides/auth/rate-limits)、[User Sessions](https://supabase.com/docs/guides/auth/sessions)、[Auth Audit Logs](https://supabase.com/docs/guides/auth/audit-logs)、[CAPTCHA](https://supabase.com/docs/guides/auth/auth-captcha)。

Supabase RLS 必须在所有暴露表上启用，并与 grants 一起维护。API 权限不能替代 RLS，RLS 也不能替代 API 的业务状态校验。

来源：[Supabase RLS 官方文档](https://supabase.com/docs/guides/database/postgres/row-level-security)

## 7. 数据访问和事务策略

- 表结构、索引、RLS、函数和种子数据统一使用 Supabase CLI SQL migration；
- 不同时使用 Drizzle migration 和 Supabase migration，避免两个 schema 真源；
- 查询可以使用 Supabase REST/PostgREST 或受控 SQL 查询；
- 跨表写操作使用 PostgreSQL RPC/事务函数；
- 订单状态转换、审批通过、收付款登记、余额重算必须是原子事务；
- 财务流水禁止由浏览器直接逐表写入；
- 所有命令接口设计幂等键，重复提交返回原操作结果或明确冲突；
- 复杂报表先使用数据库 view/函数，数据量增长后再增加报表读模型。

## 8. 文件和异步任务

- 对象存储目标为七牛云，大文件不存入 PostgreSQL；
- 当前没有经确认的前端上传/下载流程，暂不实现对象存储 SDK、文件 UI/API 或授权 URL；
- 流程确认并另立任务后，再确定对象元数据、访问授权和 URL 生命周期；
- 文件病毒扫描、批量导入、导出和大报表采用异步任务接口；
- 第一阶段不引入微服务队列，先使用 Worker 调度能力和数据库任务表；
- 任务需要重试次数、状态、错误信息和审计记录。

## 9. 权限和安全基线

- Supabase Auth 负责身份；
- API 负责角色、组织和业务权限；
- PostgreSQL RLS 负责租户和行级隔离；
- service role 只允许存在于 Worker Secret；
- 前端只使用 publishable/anon 级别配置；
- 审计记录保存操作者、组织、动作、对象、前后值摘要、请求 ID 和时间；
- 生产日志禁止写入密码、Cookie、Authorization、CSRF 和完整个人证件信息；
- 测试和 UAT 只使用虚构数据。

## 10. 部署方案

### 第一阶段

- Cloudflare Workers：静态前端 + Hono API；
- Supabase Free：数据库、Auth、RLS；
- 七牛云：对象存储目标，当前暂不接入；
- `workers.dev` 默认域名即可开始试运行；
- 既有服务器每天执行健康查询和加密备份脚本。

### 迁移条件

出现以下任一情况时评估付费或迁移：

- Supabase 低活跃暂停影响业务；
- 数据量、备份保留期或并发超出免费额度；
- 中国大陆访问延迟或稳定性不满足要求；
- 需要持续运行的 Go/Python 批处理服务；
- 需要企业域名、SLA、集中监控或合规审计。

迁移目标保持 PostgreSQL、SQL migration 和 API 契约兼容；对象存储适配细节在七牛云集成任务中确定，避免绑定业务模型。

## 11. 测试和交付要求

- TypeScript 类型检查和 ESLint；
- Vitest：领域规则、错误码、权限和 API 单元测试；
- Supabase 数据库策略测试：RLS、约束、事务函数；
- Playwright：登录、订单、游客、收付款、审批、结算主流程；文件上传/下载测试待 `R-FILE-01` 触发并完成流程设计后纳入；
- API 契约测试：前端共享类型与实际响应一致；
- 每个 P0 功能必须有可复现的 UAT 数据和验收记录；
- 部署前验证真实 Worker、真实 Supabase Auth 和真实数据库请求链路。七牛云链路仅在对应集成纳入范围后验证。

## 12. 不变的架构原则

1. 不复制历史 `erp` 目录作为新系统代码基座。
2. `Docs/REPLICATION_SPEC.md` 只保存目标系统事实和证据。
3. `Docs/REQUIREMENTS.md` 保存业务需求和验收要求。
4. 本文保存技术选型和架构边界；若发生变更，必须更新本文并记录原因。
5. 业务规则优先写入服务层和数据库约束，不能只依赖页面按钮隐藏。
6. 财务数据优先保证可追踪、可审计和事务一致性，再考虑页面便利性。

## 13. 后续实施顺序

1. 建立 monorepo 目录：`apps/web`、`apps/api`、`packages/contracts`、`supabase/migrations`。
2. 完成 Auth、组织、角色、租户和 RLS 骨架。
3. 完成基础字典、供应商、客户和路线。
4. 完成订单、游客和导入导出；文件存储流程触发后再单独实现附件。
5. 完成财务项目、收付款、审批、余额和审计。
6. 完成 CRM、报表、通知和异步任务。
7. 根据实际访问量决定是否引入付费计划、独立域名或 Go 批处理服务。
