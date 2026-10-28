# Task 3: Supabase 身份与 RLS 骨架

## 今日完成

- 新增 Supabase CLI 项目配置、身份 schema 迁移、JWT 组织上下文与权限函数、空 seed 文件。
- 新增 14 条 pgTAP 断言，覆盖成员读取、非成员拒绝、权限、RLS 阻止管理员改变成员组织归属、自助组织初始管理员以及禁止加入他人组织。
- 新增 Vitest 结构回归测试；`pnpm vitest run` 通过（7 个测试文件、12 个用例），`pnpm typecheck` 通过。
- Task 3 代码已提交；Supabase CLI/数据库运行验证仍未完成，不能标记为完整验收。

## 关键决策

- 组织上下文从 JWT 顶层 `organization_id` 读取，并在 `current_organization_id()` 中再次验证当前 `auth.uid()` 的成员关系；未提供或不匹配时返回 NULL。
- `has_permission` 依照本阶段角色骨架映射 admin/operator/finance。此映射是实现提案，后续组织/权限 API 应与其对齐。
- 初始成员策略只允许组织创建者将自己添加为 admin；普通成员变更由 API 控制，审计事件仅开放受权限保护的读取。
- `organization_members` 仅开放 `organization_id` 列的 UPDATE 权限，并以管理员权限和当前组织为 RLS `USING`/`WITH CHECK` 条件；pgTAP 使用管理员上下文尝试跨组织更新，避免把 GRANT 拒绝误当成 RLS 证明。
- seed 保持为空，避免引入真实或固定用户数据。

## 遇到的问题

- 当前环境没有 Supabase CLI。尝试临时通过 pnpm 下载时遇到 registry 下载超时/错误；Docker Windows engine pipe 未运行。WSL 的 Docker daemon 可用，但 Supabase CLI 容器镜像拉取被 registry 拒绝，因此未能运行 `supabase db reset && supabase test db`。
- 因此 pgTAP SQL 用例已写入但未在 PostgreSQL 执行；Vitest 只校验结构与测试文件存在，不替代数据库策略验收。
- 当前 JWT 组织 claim 的签发/切换流程属于后续 Auth/API 集成决策，本 Task 只实现数据库消费和成员校验。

## 下一步计划

- 在可用 Supabase CLI 环境执行 `supabase db reset && supabase test db`，修正任何迁移或 RLS 测试问题后再将 Task 3 标记完成。
- 后续 Task 4/5 确认可信组织上下文的签发/切换机制，并将服务权限及成员操作与本迁移策略保持一致。
