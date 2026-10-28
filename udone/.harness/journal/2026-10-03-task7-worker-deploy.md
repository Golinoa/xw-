# Task 7 Worker 部署配置与 smoke 验收

> 历史记录：以下内容描述当时的 R2 方案。2026-10-03 需求更新后，存储接入延期；当前实现与 Task 7 计划已移除 Worker 的 R2/ATTACHMENTS 部署及健康检查依赖。此记录不代表当前设计。

## 今日完成

- 新增根 Wrangler 配置、Worker 环境类型、健康检查、Supabase bearer 验证及 R2/静态资源绑定。
- 增加部署配置/前端产物密钥扫描和 Playwright smoke；本地 Worker smoke 2 项通过，真实登录/组织切换/RLS 用例因未配置专用 fixture 跳过。
- `pnpm build`、`pnpm check:deploy`、`pnpm typecheck`、`pnpm vitest run`、Task 6 auth E2E、`pnpm wrangler deploy --dry-run` 均已通过；`git diff --check` 通过。
- 在 Task 7 计划中记录真实部署门槛和本地结果；计划仍未完成。

## 关键决策

- 健康响应只提供状态、版本、request ID 和依赖状态，不返回上游响应详情或密钥。
- 组织成员查询使用已验证的用户 bearer token 与 publishable key；不使用 service-role key 执行租户查询。
- 不将真实凭证或测试账号写入仓库；不伪称已完成线上验收。
- 独立自审在当前任务内完成，未转发给其他会话。

## 遇到的问题

- Wrangler 未认证，`wrangler whoami` 提示需要登录；Cloudflare 实际部署未执行。
- `supabase status` 因缺少 `supabase_db_udone` 容器无法提供本地数据库验收；专用 SMOKE_* 测试 fixture 也未配置。
- Cloudflare R2 bucket 名称仍是待创建/核验的配置提案。
- API 的 X-Organization-ID 经成员关系校验，但部署环境仍需验证组织上下文如何与数据库 RLS 策略中的 JWT claim 对齐。
- `pnpm build` 有既存大 chunk 提示，未扩展为本任务的性能优化工作。

## 下一步计划

- 完成 Cloudflare Wrangler 登录并创建/核验各环境 R2 bucket，再执行实际部署。
- 配置专用虚构 Supabase smoke 用户、成员与非成员组织，运行真实登录、组织切换和 RLS 拒绝链路。
- 验证组织上下文与 RLS JWT claim 的生产对齐后，更新 Task 7 Step 4 证据；在此之前保持计划未完成。
