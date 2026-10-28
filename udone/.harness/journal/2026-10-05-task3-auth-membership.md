# 2026-10-05 Task 3 登录、成员生命周期与权限

## 今日完成
- 完成邮箱登录标识、密码恢复、会话失效边界与 CAPTCHA 产品决策文档。
- 增加角色权限/数据范围合同、成员状态、邀请与审计迁移、调用者 JWT RPC、Worker 实时成员校验和成员 API。
- 增加管理员邀请/成员更新界面、邀请接受、通用登录/恢复反馈和 CAPTCHA 控件。
- 定位 E2E 旧页面根因并在独立新鲜 Vite 服务复测：恢复、邀请接受、管理员发邀请及到期状态 3/3 通过。
- 成员面板改用原生表单控件，避免依赖尚未提交的 Ant Design Vue 包/注册改动；再次运行浏览器 3/3、API/Web 类型检查和 Web 构建均通过。
- 将登录/恢复/邀请/CAPTCHA 行为拆到 `AuthFlow.vue`，保留原 `LoginView.vue` 的 Ant Design Vue WIP 为 unstaged；基于干净 HEAD + 新组件的 `/tmp` 快照跑登录/切换/退出、generic recovery、邀请接受和管理员邀请 5/5，配置 CAPTCHA widget 测试 1/1；Web typecheck、生产构建通过。新增 CAPTCHA E2E 在未配置站点 key 时跳过，配置 key 时单独执行。
- 按后续明确授权，仅在 WSL 对被中断安装影响的忽略依赖目录运行 `pnpm install --frozen-lockfile`。命令报告 lockfile up-to-date、356 包全部从本地 store 复用、下载 0；第一次调用缺少 WSL Node 的 `PATH`，链接创建后 lifecycle 失败；加入 Node 22 路径后重跑成功，esbuild/workerd postinstall 均通过。安装前后 lockfile、package manifest、登录/布局/首页及主入口源码 SHA256 相同；未改 Windows `node_modules` 或源码 WIP。16 个根直接依赖和 Task 3 所需根/workspace `.bin` 链接已核验可解析。
- 恢复后复跑 Task 3 门禁：WSL 隔离 Supabase Postgres 4 files/61 assertions；`/tmp` 完整 Vitest 18 files/74 tests；认证浏览器登录/切换/退出、generic recovery 和接受/发送邀请 5/5，配置 CAPTCHA widget 1/1（无站点 key 时该用例跳过）；Auth store 9/9；API/Web TypeScript、SQL 格式 10 files、schema inventory 5 migrations 与 Web production build 均通过。Supabase 测试容器已停止并保留 Docker volume；Redis/MySQL 未触碰。现有 bundle 约 1.75 MB/534 KB gzip 告警仍记录为既有项。
- Step 6 已验收并提交认证 UI 的 scoped commit；Ant Design Vue `LoginView.vue` 和其他用户 WIP 哈希保持不变、均未暂存。Task 4 未开始。

## 双端 handoff gate 复核（2026-10-05）
- `~admin` 前端链：Task 1 的工作区导入、锁定、基线门禁和文档项均已勾选，foundation commit `f8de6e4` 存在。Task 2 尚未通过：计划仍有完整锁文件审计绿色结果及托管 PR/required-check 两项未勾选；最近质量门因 2 条 high（总计 4 moderate、2 high、0 critical）失败，且无 Git remote，无法运行托管 PR 或验证分支保护。未派发 admin Task 3。
- `udone` 后端链：本仓库 Task 1 与 Task 2 的验收项均已勾选并有提交记录；Task 3 Step 6 现以 `feat: isolate Task 3 authentication UI` scoped commit 完成。现有无关用户 WIP 仍保留，不影响 Task 自身提交。
- 按 handoff 的双链门槛，admin Task 2 未通过前不推进其 Task 3 或跨端业务联调；依用户指示也不启动 ERP Task 4。此轮只完成交接状态复核，没有修改 `~admin`。

## 关键决策
- 登录身份使用已验证 Supabase Auth 邮箱，不建立 username 映射；display name 仅展示。
- 管理员邀请和更新成员经受权限约束的 RPC；service role 只用于 Auth Admin 邮件，不用于业务表变更。
- 成员停用在 Worker 每个受保护请求中复核，已签 access JWT 仍可能存续到过期，不宣称即时撤销。
- 邀请链接显示待处理状态和到期时间，接受失败在登录界面展示；管理员可按用户 ID 调整成员角色与状态。

## 遇到的问题
- Ant Design Vue 的表单项标签没有给输入控件提供可访问名称；为字段增加关联标签后浏览器恢复流程通过。
- 登录按钮名称含组件生成空格，E2E 改为匹配空格不敏感名称。
- 初次管理员 E2E 复用旧 Vite PID 624958，返回的 `/src/views/HomeView.vue` 不含当前成员面板源码。停止该任务启动的旧服务，并让测试复用独立 `/tmp` 镜像中的新鲜 Vite 后，3/3 通过。
- secret-canary 用例在共享挂载环境超过 5 秒；同一用例在 `/tmp` 隔离依赖目录 180 ms 通过，之后完整 Vitest 在隔离副本以 2 workers 跑 18 文件/74 测试全部通过。推测嵌套同步 Node/secretlint 子进程在共享 WSL 工作区负载下触发 5 秒门限；隔离测试未复现，因此不把单一原因说成已证实，也未改无关工具代码。
- WSL Supabase CLI 2.119.0 的隔离数据库端口 55432 跑 pgTAP 4 文件/61 assertions 通过，后停止测试容器并保留 Docker volume；Redis/MySQL 容器未动。
- Playwright `webServer` 在共享项目触发 pnpm 自动安装，安装中途终止后，忽略的共享 workspace `node_modules` 直接链接和 `.bin` 不完整。后续在 `/tmp` 隔离依赖/项目镜像验收；不要在没有明确授权时对混合依赖目录重装。

## 下一步计划
- Task 3 Step 6 已完成；按双端 handoff 核对 `~admin` 前端链与 `udone` 后端链各自的 Task 1/2 门槛。只有两条链满足各自完成标准后才考虑运营业务域联调；当前不开始 Task 4。
- 保持既有 Ant Design Vue 页面、harness 文档、锁文件及其他工作树变更原样。
