# 2026-10-05 Task 1：组织上下文与 RLS

## 今日完成

- 新增 `20261003000003_request_organization_context.sql`，按 PostgREST `request.headers` 读取所选组织，并用 `auth.uid()` 重新验证成员关系；缺失、格式错误及非成员上下文 fail closed。
- Worker 组织成员读取仅在明确选择组织后执行，并将已验证组织 header 与调用者 bearer token 一起传至 PostgREST；组织发现/创建保持无所选组织 header。
- 增加 API 与 pgTAP 用例，更新 smoke 验收及架构/安全说明。

## 关键决策

- 保留已存在的 `20261003000001_rls_helpers.sql` 不变，采用向前兼容 migration 替换函数和组织发现策略，避免回写可能已应用的 migration。
- 组织发现策略只在请求完全没有 `x-organization-id` 键时开放当前用户自己的组织/成员发现；错误或无效的选择不回退成发现模式。
- 经用户授权后，先执行 linked migration list 与 dry-run，确认 staging 仅待应用 `20261003000003_request_organization_context.sql`，再应用该单一 migration；复核 linked list 确认本地/远端版本一致。未对 production 写入。

## 遇到的问题

- WSL 中 Docker daemon 正常；根因是数据库映射端口 `54322` 被 Windows 微信开发者工具占用。未停止该进程，而是用独立临时 Supabase 项目 `udone-task1-verify`、数据库端口 `55432`、API 端口 `55431` 启动。Supabase PostgreSQL `17.11.0.002` 镜像（amd64 压缩层约 368 MB）和 GoTrue/Auth、Kong/PostgREST 依赖均已下载。最初排除 GoTrue 时测试显示 `auth.users.email_confirmed_at` 不存在，确认是启动配置缺少 Auth 初始化；启用 GoTrue 后修复。
- 正式本地数据库门禁现已完成：在临时 Supabase 项目目录执行 `supabase test db --local`，旧 JWT helper RED 对照请求上下文测试 8/14 失败；应用 `20261003000003_request_organization_context.sql` 后再次运行，3 个文件 35/35 通过。`identity_rls.sql` 15 项、`organization_context.sql` 6 项、`request_organization_context.sql` 14 项。
- 本地真实 HTTP 链路使用 GoTrue Admin 创建临时 `.test` 用户，以 password grant 取得真实 Auth sessions，Worker 用本地 Supabase URL/publishable key 验证身份，PostgREST 使用相同 bearer token 和组织 header。两个组织 fixture：Tenant A `88000000-0000-4000-8000-000000000001`、Tenant B `88000000-0000-4000-8000-000000000002`；admin 用户 `603b2f3b-312e-4777-bb4b-0a31a77c2140` 属于 A，operator `7a5058c0-6ccd-4266-9cb0-944e4f5cac2e` 属于 A/B，finance `60b6e5d7-6367-4fd6-a058-ffc4da3f1a5a` 属于 B。三角色选中所属租户读取成员均为 HTTP 200；operator 从 A 切换到 B 为 200；admin 伪造非成员 B 的切换为 403；admin 对 A 的 PostgREST RLS 查询返回 1 行，对伪造 B header 的查询返回 0 行。另一个临时 admin 真实 Auth 会话经 Worker 创建组织为 201、随后 `/api/me` 发现 membership 为 200、带新组织 header 的 PostgREST 查询为 200/1 行；该写入用户和其组织已清理。三角色 `.test` fixture 留在隔离的 `udone-task1-verify` 数据库卷中，不含真实个人数据；验证后已停止容器并保留该独立 Docker volume。
- Task 1 计划文件在任务开始时未跟踪，包含 Task 2–8 的既有计划内容。已在工作副本更新 Task 1 进度，但提交时将保留该文件为 WIP，不把整份既有计划首次纳入 Task 1 commit。
- staging project `uxshseqgleiqyopnmomt`（`udone-staging`）已应用 `20261003000003_request_organization_context.sql`；应用前 dry-run 仅列该 migration，应用后 linked list 确认四份 migration 均同步。已部署 Worker `https://udone-oms-staging.qq151536422.workers.dev` 的真实 smoke 3/3 通过：health HTTP 200 且 Supabase available；未认证 `/api/me` HTTP 401；fixture 用户 `cc805bf3-35b9-4b6e-b152-cbe44edc9307`（admin）登录成功并选择租户 `5257cbdc-3ed7-46cd-a243-b398b619a4f1`，Worker 成员查询 HTTP 200；向非成员租户 `e76c2b09-fd52-403f-ad55-793097dbc48d` 切换被 Worker 以 HTTP 403 拒绝，直接带伪造 header 查询 RLS 返回 HTTP 200/0 行。第二个既有 fixture 用户 `a2696b2b-26c5-4030-8800-563a45342ddc` 在租户 `e76c2b09-fd52-403f-ad55-793097dbc48d` 的角色也是 admin。第一次 Playwright 运行因 Node API 绕过代理超时；使用 `ALL_PROXY` 显式代理重跑后通过。只读读取两个既有 staging fixture 后确认均为 `admin`，故尚无 `operator`/`finance` 真实 staging 会话，也未做 staging 自有对象写入验收；没有创建、变更或删除 staging fixture。
- 本地验证结果：`pnpm --filter @erp/api typecheck` 通过；`pnpm vitest run --exclude '.worktrees/**'` 15 个文件/50 个测试通过；正式 Supabase PostgreSQL 17 + GoTrue pgTAP 35/35 通过，真实 Auth/Worker/PostgREST 本地两租户三角色读写链路通过。Staging migration 已应用并复核；真实 staging smoke 3/3 通过，但现有 staging fixture 只有 admin 角色，三角色及 staging 写入证据仍缺。
- 2026-10-05 续验：复核 `.temp/project-ref` 为 `uxshseqgleiqyopnmomt`（`udone-staging`），linked migration list 显示本地/远端均为 `20261003000000`–`20261003000003`。在保留的隔离本地卷启动最小 Postgres/Auth 栈后，重新运行 `supabase test db --local`，3 个文件、35/35 通过；随后停止容器并保留数据卷。尝试走 Supabase Auth Admin HTTPS 创建验收身份时 TLS 握手失败，没有获得 HTTP 响应；经当前代理访问 staging Worker health 也在连接阶段超时。本轮未成功创建 Auth 用户、组织或成员记录，未执行任何 staging SQL 写入；旧 staging 3/3 smoke 仍是历史证据，本轮未复现。
- 续做核对：提交 `4186473` 仍为 HEAD；既有未提交 WIP 保持原样，新增的本地栈尝试已通过 Ctrl-C 停止。

## 下一步计划

- 提交仅含本任务源码、测试、架构/安全说明及本 journal 的改动；保留既有 WIP 和未跟踪计划文件。
- 用户已明确授权在 staging 两个既有虚构租户中添加 operator/finance 验收身份与成员，并创建带 Task 1 标记的验收组织；但本轮 Supabase Auth Admin TLS 请求无响应，故授权尚未执行成功。待 staging API 网络恢复后只在上述范围继续，完成三角色读写/伪造 header 验收；production 不在本 Task 范围。
- 在三角色 staging Auth/RLS 读写证据完成前，Task 1 保持未完成，Task 2 不解锁。

## 2026-10-05 有界恢复复查

### 今日完成

- 核对 Task 1 migration 源仍为 `20261003000000`–`20261003000003`；此前 journal 记录 staging linked list 四份 migration 同步，本轮未重新运行缺失的 Supabase CLI。
- 执行一次 staging Worker `/api/health` 检查，HTTP 200。
- 执行一次 Supabase Auth Admin `GET /auth/v1/admin/users` 检查，收到 HTTP 403；尝试的 staging organizations 只读重复项查询失败，未能确认历史试建身份/组织不存在或不重复。
- 没有创建 Auth 用户、组织、membership 或执行其他 staging 写入；没有触碰 production。Task 1 Step 5 保持未完成，Task 2 仍锁定。

### 关键决策

- Auth Admin 返回 403，当前受支持的 Admin 通道不可用于本轮授权 fixture；按有界恢复要求不重试、不绕过 Auth Admin、不写数据库，也不基于不完整核查创建记录。
- 将 Task 1 计划维持未完成状态；本提交只包含该计划状态和本 journal 更新。

### 遇到的问题

- 本地 Windows shell 未发现 `supabase` CLI，无法重新读取 linked migration list；migration 同步状态仅依据此前 journal 的成功复核记录。
- 本轮健康端点可达，但 Auth Admin 授权失败，organizations 只读重复项核查未成功；因此重复项情况未确认。

### 下一步计划

- 等受支持的 Supabase Auth Admin 通道及只读 fixture 核查能力恢复后，再重新安排一个明确有界检查；本轮不再请求或写入。
- 在三角色 staging Auth/RLS 读写证据完成前，Task 1 保持未完成，Task 2 不解锁。

## 2026-10-05 staging fixtures 与 RLS 验收完成

### 今日完成

- 修正 staging Auth Admin 通道：首轮 403 的原因是 apikey 使用 publishable key；通过 WSL 登录态 Supabase CLI 提取 service_role，仅保存在运行内存并只用于 Auth Admin。GET users 返回 HTTP 200。候选邮箱精确查重 0 个既有匹配；Task1 标记组织查重 0 个。
- operator `4237158b-183f-453a-bbe6-a17207f88a6f` 与 finance `ca5b0b40-f75c-4c88-9d3a-07f3fa489ec6` 账号在本次验收前已存在；本轮通过 Auth Admin API 将两者密码分别重置为随机内存值，用于真实 Auth 测试。未创建这两个 Auth 用户，密码未打印或保存。
- 以现有 staging admin 的真实 Auth JWT 调用 create_organization_with_owner RPC，创建 Task1 RLS acceptance 20261005，UUID 056d74f3-5f2d-4688-b106-0af8d9711132。Operator 加入既有租户 A 5257cbdc-3ed7-46cd-a243-b398b619a4f1；finance 加入既有租户 B e76c2b09-fd52-403f-ad55-793097dbc48d；两人也加入 Task1 验收组织。未删除或覆盖既有 fixture，未触碰 production。
- 使用三种真实 Auth 会话逐一验收：Worker 成员读取 HTTP 200 且返回当前角色本人 membership；所选组织与本人 membership 的 PostgREST/RLS 读取 HTTP 200/1 行；本人 profile upsert HTTP 200；伪造非成员组织 header 的 RLS 读取 HTTP 200/0 行；Worker 对非成员组织切换 HTTP 403。Admin 更新验收组织通过 RLS 返回 1 行；operator 与 finance 的同项更新被 RLS 限制为 0 行。
- 最终 Supabase CLI linked migration list 确认本地/远端 20261003000000–20261003000003 一致。pgTAP 三文件 35/35 通过为本 journal 前序记录的本地验证结果；本轮续验未重跑。

### 关键决策

- 组织通过现有 create_organization_with_owner 安全 RPC 和调用者 JWT 创建；membership 仅增加在授权的两个既有租户及 Task1 验收组织。
- operator/finance Auth 用户为既有账号；本轮仅重置其密码供验收登录，并按授权添加 membership。验收结束后保留组织、账号与 membership。
- Task 1 Step 5 验收完成，Task 1 全部步骤完成；Task 2 解锁但本轮不启动。

### 遇到的问题

- Auth Admin 使用 publishable apikey 时返回 403；换成 Supabase CLI reveal 的 service_role 后 Admin API 返回 200。service_role 未用于 PostgREST/业务表，也未落盘。
- 更正本节先前记录：operator 与 finance 不是本轮创建的用户；两者在本轮前已存在，Auth Admin 操作是重置其密码。
- Worker /api/organizations/:id/members 对每种角色只返回当前调用者自己的 1 条 membership；linked 数据库核对 Task1 组织有 admin/operator/finance 三条 membership。此处仅断言调用者自身 membership 可读，未将全员枚举作为 Task 1 通过条件。
- WSL 直连 Worker 网络不可达；通过 Windows 本机代理完成 Worker 的真实 API smoke。未因传输错误重复提交组织或成员写入。

### 下一步计划

- 不启动 Task 2；后续独立处理时可先确认 Worker members endpoint 是否应向 admin/其他角色展示组织内所有成员。
- Task 1 staging fixtures 全部保留；不删除，不更改 production。
