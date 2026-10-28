# 有单软件运营后台

本项目面向软件提供方内部人员，管理软件客户、产品套餐、合同与线下收款、SaaS 订阅/授权、租户交付、私有化部署台账及售后工单。它与旅行社员工使用的 `../udone` ERP/OMS 是不同的业务界面。

## 项目状态

- PRD 已定稿，见 [Docs/PRD.md](Docs/PRD.md)。
- 技术与运行边界见 [Docs/TECH_SELECTION.md](Docs/TECH_SELECTION.md) 和 [ARCHITECTURE.md](ARCHITECTURE.md)。
- 前端使用 Vben `apps/web-antd` workspace，业务 API 仍由 `udone` 的 Hono Worker 提供。

## 前端开发

- 工具版本：Node `24.20.0`（`.node-version`）、pnpm `10.33.4`（Corepack 按根 `package.json` 选择）。
- 安装 antd 应用、lint 工具、Vite 配置包及其 workspace 依赖：`corepack pnpm install --filter '@vben/web-antd...' --filter '@vben/vsh...' --filter '@vben/vite-config...' --filter '@vben/eslint-config...' --filter '@vben/oxfmt-config...' --filter '@vben/oxlint-config...' --filter '@vben/stylelint-config...' --filter . --frozen-lockfile`。
- 本地开发：`corepack pnpm dev:antd`；生产构建：`corepack pnpm build:antd`。应用 typecheck：`corepack pnpm --filter @vben/web-antd typecheck`。
- Vben demo 页面和 mock 认证/API 仅为脚手架，不代表本产品功能；业务身份/API 接入前需替换或隔离 demo 入口。生产 API base 暂设同源 `/api`，未接入真实后端。
- Vben 来源、锁定 commit、license、workspace 范围与 demo 清单见 [技术选型](Docs/TECH_SELECTION.md) 和 [实际目录图](.harness/PROJECT_STRUCTURE.md)。

## 文档入口

- [Agent 规则](AGENTS.md)
- [页面设计规范入口](DESIGN.md)
- [产品需求](Docs/PRD.md)
- [技术选型](Docs/TECH_SELECTION.md)
- [系统架构](ARCHITECTURE.md)
- [文档地图](Docs/README.md)
- [Harness 指南](.harness/README.md)

## 业务边界

运营后台的商业客户、合同、账款、授权和交付由运营域管理。旅行社租户中的员工和经营数据仍由 `udone` 管理；所有跨系统开通或权益变更均通过受控 API，不直接改写旅行社业务记录。
