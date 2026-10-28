# Task 3 数据库验收恢复

## 今日完成

- 在 WSL Ubuntu 24.04 使用官方 Supabase CLI 2.119.0 native runtime 启动本地 PostgreSQL；未连接远端 Supabase 项目。
- 对原有 `0001_`、`0002_` 迁移名执行真实数据库检查时，`supabase test db` 因 `public.organizations` 不存在而失败；据此确认 reset 未应用这两份迁移。
- 将迁移重命名为 14 位时间戳格式，增加迁移名称/顺序回归断言；`pnpm vitest run tests/database/identity-rls.test.ts` 通过（5 tests）。
- 真实执行 `supabase db reset`，观察到两份迁移和 `supabase/seed.sql` 均已应用；随后 `supabase test db` 全部通过（14 pgTAP tests）。
- 提交 `7782b93 fix: use timestamped Supabase migrations`；更新 Task 3 计划检查项与验收记录。

## 关键决策

- 将迁移文件名改为 `20261003000000_identity.sql` 和 `20261003000001_rls_helpers.sql`，符合 Supabase CLI 的时间戳迁移格式并保留原 SQL 内容。
- 选择 WSL native runtime，避免依赖当前不可用的 Windows Docker Desktop 镜像下载；WSL 的 GitHub TLS 根证书只通过进程级 CA 环境变量提供，没有改系统信任库或仓库 Supabase 配置。
- 验收结论依据真实本地 PostgreSQL `db reset` 和 pgTAP 结果；静态 Vitest 只用于防止迁移命名回归。
- 严格限制在 Task 3，Task 4 未开始。

## 遇到的问题

- 起初 Windows 没有 Supabase CLI，Windows Docker Desktop 服务未运行；WSL 自带运行中的 Docker Engine，但 Docker 镜像源不可用。通过官方 CLI release 和 native runtime 恢复了本地验证。
- WSL GitHub 域名使用 SteamTools TLS 代理证书，WSL 默认 CA 不信任它；加入进程级 CA bundle 后官方服务包校验下载成功。
- 原短迁移版本号未被 reset 应用，最初的 pgTAP 验收因此在 schema 未创建时失败。修正为时间戳文件名后，最终 reset 与 14 个 pgTAP 用例均通过。

## 下一步计划

- 等待用户安排后再开始平台基础计划 Task 4；本任务未实现或修改 Task 4 内容。
