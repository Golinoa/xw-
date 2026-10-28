# Task 5：组织上下文和成员管理 API

## 今日完成

- 新增 `GET /api/me`、组织创建、组织切换和成员列表路由，并挂载至 Worker app。
- 新增组织仓储服务：使用调用者 JWT 访问 Supabase REST；组织与初始 owner 成员通过事务 RPC 一次写入。
- 新增 Supabase migration 和 pgTAP 覆盖，允许用户读取自身跨组织成员关系及组织名称，维持其他用户数据隔离。
- 新增 9 个组织路由测试；`pnpm vitest run` 通过 32 个测试，`pnpm typecheck`、`pnpm build` 和 `git diff --check` 通过。
- 数据库验收收尾：WSL Ubuntu-24.04 原生 Supabase CLI 2.119.0，进程级设置 `SUPABASE_EXPERIMENTAL_STACK=1`、`NODE_EXTRA_CA_CERTS` 和 `SSL_CERT_FILE` 后，`supabase db reset` 成功应用 3 份 migration 和 seed；`supabase test db` 的 2 个文件、20 个 pgTAP 用例全部通过。

## 关键决策

- 不使用 service role；仓储将已验证的调用者 JWT 转发到 PostgREST，让请求继续受 RLS 约束。
- `POST /api/organizations` 通过安全定义的 SQL RPC 创建组织与 owner 成员；RPC 从 `auth.uid()` 获取 owner，避免信任请求体中的所有者字段。
- Task 5 接口依赖需要跨组织读取自己的成员关系，故新增策略只开放当前用户自己的成员记录和其所属组织信息；成员列表仍需 API 权限及当前组织校验。
- 依据 Task 5 的原子事务和组织切换要求，增加一份增量 migration，并更新已有 RLS 测试期望；这些变更仍只服务于本 Task。

## 遇到的问题

- 原生验收首次直接 reset 时本地栈未运行；按 Task 3 原生启动命令恢复时，先遇到旧 `main` 原生栈占用 54322。停止该同仓库的旧本地验收栈后，精简启动配置因排除 Auth capability 而缺少 `auth.jwt()`；启用 Auth 后原生栈成功启动并完成 reset/test。最终数据库验证已通过。
- 仓库嵌套路径 `udone` 未包含独立 `AGENTS.md`、`ARCHITECTURE.md` 或 `.harness` 约束；使用工作区根目录的指引和架构文档，并将本次日记放在仓库内。

## 下一步计划

- Task 5 的代码和验收记录均已提交；后续按计划执行 Task 6 前端登录与组织切换骨架，并确保前端切换上下文与此 API/RLS 契约一致。
