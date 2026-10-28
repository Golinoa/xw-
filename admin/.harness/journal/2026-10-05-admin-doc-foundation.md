# 运营后台文档基线

## 今日完成

- 将 `Docs/PRD.md` 定稿为 1.0，记录运营后台商业边界、角色、功能域、流程、权限、安全、性能和验收。
- 建立项目根文档入口、产品/技术文档地图及 `.harness` 工程约束初始版本。
- 核对 `udone` 的 AGENTS、DESIGN、架构、需求、技术选型和工程规范，并用于划定同级项目职责。

## 关键决策

- `~admin` 为独立 Vben `web-antd` 前端；首期复用 `udone` Hono Worker、Supabase 项目和 Supabase Auth 项目。
- 运营数据、API 权限与 RLS 使用专属逻辑域；迁移/API 的后端真源仍归 `udone`。
- 运营与旅行社人员的授权池逻辑分离，但共用 Supabase Auth 不等同于独立认证服务。
- 页面视觉规则复用同级 `udone` 的 Design-system，不复制平行版本。
- 本次仅建立文档与规则，没有导入 Vben 代码或修改 `udone`。

## 遇到的问题

- Vben `web-antd` 依赖多个 `workspace:*` 内部包，因此后续导入必须保留完整 workspace，不能只复制单个 app 目录。
- `udone` 工作区有大量既存未提交改动；本任务没有修改或清理这些文件。

## 下一步计划

- 根据 PRD 和技术选择开始导入/裁剪 Vben `web-antd` 前端，并与 `udone` 后端接口对接。
- 实现前先补全运营 API 契约、Supabase 运营 schema/RLS、运营身份与租户授权命令设计及自动化验收。
