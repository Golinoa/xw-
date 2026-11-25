# 有单软件运营后台技术选型

- 日期：2026-10-05
- 状态：方向已确认；Vben Task 1 workspace 导入与本地基线验证已完成，业务/API 与部署尚未执行
- 对应需求：[PRD.md](PRD.md)

## 1. 最终选择

### 前端：Vue Vben Admin v5 `apps/web-antd`

- 采用官方 `web-antd` 应用作为独立运营前端模板，保留 Ant Design Vue 组件体系，与既有产品技术方向一致。
- Vue Vben Admin 官方说明其使用 Vue 3、Vite、TypeScript，提供动态路由权限；`apps/web-antd` 当前包清单标为 MIT 并依赖 `ant-design-vue`。[中文 README](https://github.com/vbenjs/vue-vben-admin/blob/main/README.zh-CN.md) [web-antd package.json](https://github.com/vbenjs/vue-vben-admin/blob/main/apps/web-antd/package.json) [MIT License](https://github.com/vbenjs/vue-vben-admin/blob/main/LICENSE)
- `web-antd` 使用多个 `workspace:*` 的 `@vben/*` 内部包，因此不能只复制 `apps/web-antd` 到空目录；首期应保留完整上游 workspace，明确只运行/构建 antd 应用，并在初始导入时锁定上游 commit 与 lockfile。
- Vben 管理后台布局、路由、主题和权限框架，不提供本项目业务模型、商业授权 API 或安全策略；不得将 demo/mock API 当作真实业务服务。
- Vben 版本会持续更新；任何上游升级都需检查 workspace 依赖、Ant Design Vue 兼容性、许可、变更日志和构建产物，不使用浮动版本作为可复现构建依据。

### 后端：复用 `udone` 的 Hono + Cloudflare Workers

- 不在 `~admin` 新建第二个业务 API 服务；运营 API 在现有 Hono Worker 的独立版本化命名空间内扩展。
- 后端扩展和数据库迁移实际落在 `udone` 代码库，由其 API、架构和迁移真源记录；`~admin` 通过稳定接口消费，不跨仓库导入私有实现文件。
- 浏览器与 API 使用 HTTPS；允许来源采用明确的运营前端域名白名单，跨域和认证策略在实现前与现有 Hono 配置一起评审。

### 数据库与认证：复用同一 Supabase 项目并隔离运营域

- 运营数据使用独立 schema/表，PRD 中以 `ops` 作为逻辑名称；确切物理名称由迁移确定。
- API 权限和 RLS 独立于旅行社角色域；所有暴露表显式授权、启用 RLS，并测试允许与拒绝路径。
- 运营账号在运营成员关系中单独维护，首期复用同一 Supabase Auth 项目。它不是独立认证服务；如后续要求独立认证基础设施，再按单独迁移方案切换身份提供方。
- 前端仅使用公开客户端配置和用户访问令牌；service role、签名密钥和 provider credentials 仅存于 Worker secrets。

## 2. 部署边界

- 运营前端单独构建和发布，使用独立入口/域名；首期复用现有 Cloudflare 账号与静态资源部署能力。
- 所有业务请求发送到 `udone` 的 Hono API；管理后台独立发布不代表拥有独立 API、数据库或 Auth 服务。
- 环境配置明确区分 local、staging、production；不同环境不得指向同一运营数据库后再通过前端开关隔离。
- 构建时不嵌入服务端密钥；前端 API base URL、Auth URL 和公开 key 按环境注入，并校验允许域名。

## 3. 存储和附件

- 合同、收款凭证等附件采用私有对象存储，由 Hono 服务验证权限并创建受控上传/下载路径。
- `udone` 已将七牛云选为对象存储目标，但其接入在旅行 OMS 中曾因缺少已确认流程而暂缓；运营 PRD 已明确附件场景，因此技术实施时优先复用该选型并单独核验凭证、区域、生命周期、文件大小/类型和访问授权。
- 附件对象键不可猜测；数据库只保存元数据和授权引用；不将 bucket 设置为公开，不在浏览器暴露管理密钥。
- 真实文件存储能力需经对应 API/权限测试后方可对外声称可用。

## 4. 模块与依赖规则

- 前端沿用 Vben workspace 的应用和共享包边界；新增领域页面归属于明确业务模块，不散布在 `apps/web-antd` 示例页面中。
- API 后端领域逻辑由 `udone` 按 PRD 的领域边界维护；前端使用公开的版本化 API 契约，不用直接 Supabase 表访问替代业务命令。
- 运营业务 API、SQL migration 和 RLS 仍只有一套后端真源；`~admin` 不复制迁移文件、不维护影子 API 文档。
- 产品、合同、账款、授权、租户交付、部署、售后和审计之间通过用例服务/命令协作，不互相直接修改对方内部表。

## 5. 备选方案与取舍

| 方案 | 结论 | 原因 |
| --- | --- | --- |
| 将运营页面并入 `udone` 前端 | 不选 | 会把软件销售后台和旅行社日常 ERP 的入口、权限与发布节奏耦合 |
| 新建完整独立后端、数据库和认证 | 首期不选 | 初期重复维护 Auth、运维和接口；当前已经明确共享现有 Hono 与 Supabase，同时以独立 schema/RLS/API 分域控制风险 |
| Vben 仅作视觉参考、自建全部后台框架 | 不选 | 重复实现后台布局、路由权限、主题和工程基建，与已选 Vben 底座方向冲突 |
| 复制 `web-antd` 单目录并丢弃 monorepo | 不选 | `web-antd` 依赖多个 workspace 内部包，脱离根 workspace 会破坏依赖解析 |

## 6. 依赖准入和版本治理

- 先复用 Vben、Vue、Ant Design Vue、Pinia、Router 和现有 `udone` 后端能力；新依赖须写明解决的问题、维护状态、运行时/包体影响、许可和安全公告。
- 导入 Vben 时保留上游 MIT 许可与版权声明，按 MIT 要求保留许可证文本；检查间接依赖许可与项目使用范围。
- 固定 Node/pnpm 版本和 lockfile。上游 `package.json` 当前声明 Node `^22.18.0 || ^24.12.0`、pnpm `>=11.0.0`，实际导入时应以选定 commit 的配置为准。
- `~admin` 和 `udone` 是并列项目，不假设它们共享同一 pnpm workspace、路径 alias 或 npm package。共享数据只经稳定 API 和显式契约。

## 7. Task 1：Vben workspace 导入基线

- 上游：[`vbenjs/vue-vben-admin`](https://github.com/vbenjs/vue-vben-admin)，release tag `v5.7.0`，锁定 commit `63a38dce49ba109f61607994e21ba921d8e970e9`；来源及文件以该官方仓库 commit 为准。
- 导入保留完整共享 `packages/`、`internal/`、`scripts/` workspace，以及唯一产品应用 `apps/web-antd`。不导入 `apps/web-ele`、`apps/web-naive`、`apps/web-tdesign`、`apps/web-antdv-next`、独立 `playground/` 与其它产品应用。
- 上游根 `docs/` 与本项目既有 `Docs/` 在 Windows/NTFS 上大小写不敏感，不能共存。为原位保留 `Docs/` 产品真源，本次不导入上游说明文档目录；Vben workspace 代码/共享包与锁文件保持在仓库根。上游说明可按上述 commit 从官方仓库查阅。
- 保留上游 MIT `LICENSE`、版权信息、根配置和唯一 `pnpm-lock.yaml`。上游配置中的 `.npmrc` 使用 `registry.npmmirror.com`；锁文件带包完整性值，安装采用冻结锁文件模式。
- 精确工具链：`.node-version` 固定 Node `24.20.0`（该版本在本机已安装且符合导入 commit 的 `^22.18.0 || ^24.0.0` engines）；根 `package.json` 的 `packageManager` 固定 pnpm `10.33.4`，通过 Corepack 运行。应用只使用 `apps/web-antd` 的上游 `typecheck`、`build`，仓库级 lint/unit-test 脚本按上游定义核验。
- 安装范围：`@vben/web-antd`、其 workspace 依赖、根工具、根 lint CLI `@vben/vsh`、Vite 配置 `@vben/vite-config` 及根 lint/format 配置包的依赖闭包；不安装其他产品应用。根 `postinstall` 限定到应用和明确使用的根工具依赖闭包，避免默认递归构建未启用的共享包。冻结安装命令为 `corepack pnpm install --filter '@vben/web-antd...' --filter '@vben/vsh...' --filter '@vben/vite-config...' --filter '@vben/eslint-config...' --filter '@vben/oxfmt-config...' --filter '@vben/oxlint-config...' --filter '@vben/stylelint-config...' --filter . --frozen-lockfile`；已审阅的 `preinstall` 只校验 pnpm，`postinstall` 构建所选工作区依赖，`prepare` 安装本地 lefthook git hook。
- 上游 demo 清单（Task 1 保留作框架脚手架，不视为运营后台业务）：登录/注册/验证码/二维码页面和 `/auth/*`、`/user/info`、`/menu/all`、`/auth/codes` 示例 API；`src/router/routes/modules/demos.ts` 的演示导航、`src/views/dashboard` 示例总览/工作台和 mock/静态演示视图；根 `.env` 的 demo 配置及 `.env.production` 原有 `mock-napi.vben.pro` 目标。本次将生产 API base 调整为同源 `/api`，避免产物指向 Vben 公共 mock 服务。上述认证/API/menu/route/demo mock 与示例总览在 Task 3 业务身份/应用壳接入前必须替换或从正式入口隔离；本 Task 不创建或猜测运营 API 契约。

## 8. 参考项目真源

- [`udone/Docs/TECH_SELECTION.md`](../../udone/Docs/TECH_SELECTION.md)：现有 Vue/Hono/Cloudflare/Supabase 和对象存储选型。
- [`udone/ARCHITECTURE.md`](../../udone/ARCHITECTURE.md)：现有 API、领域、数据库和 RLS 分层。
- [`udone/Docs/REQUIREMENTS.md`](../../udone/Docs/REQUIREMENTS.md)：旅行社业务边界，避免运营后台重复拥有其功能。

如本文与上述代码库实际实现不符，以现有源代码、迁移和对应真源为准，并先修订选型/集成决策，再实现跨项目接口。
