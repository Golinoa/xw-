# Task 1：monorepo 和开发命令

## 今日完成
- 建立 pnpm workspace 和 `@erp/web`、`@erp/api`、`@erp/contracts` 三个 package；配置根级 `dev`、`typecheck`、`test`、`build` 命令。
- 加入严格 TypeScript 基础配置、Vite Vue 入口、Hono Worker 入口和 `/api/health` 路由、Wrangler 配置、Vitest 配置及仅含变量名的 `.env.example`。
- 编写 workspace smoke test，先确认因 workspace manifest / Hono 入口缺失而失败，完成 scaffold 后通过。
- 生成 pnpm lockfile 与必要的 `.gitignore`；按 pnpm 11 要求显式允许 `esbuild` 和 `workerd` 安装脚本。

## 关键决策
- 遵照已确认架构，使用 Vue 3、Vite、TypeScript、Hono、Wrangler 和 pnpm workspace；此任务只提供可运行的基础入口，不实现业务功能。
- `SUPABASE_SERVICE_ROLE_KEY` 只作为空变量名出现在 `.env.example`，并通过忽略规则保护真实 `.env`、`.dev.vars` 和构建产物。
- Wrangler 配置留在 `apps/api/wrangler.toml`，以免提前创建 Task 7 计划中的根目录 `wrangler.toml`。
- pnpm 11 安装时自动记录了当天发布的 workers-types 版本例外；保留该锁定策略配置以使安装可复现。

## 遇到的问题
- 默认 npm 镜像下载依赖包失败/超时；切换仅限当前命令进程的 registry 环境变量后安装成功。
- pnpm 11 首次安装拒绝未经批准的 `esbuild`、`workerd` build scripts；在 workspace 配置中显式允许后成功执行。
- Wrangler `deploy --dry-run` 输出成功打包且显示 `--dry-run: exiting now`，但进程未退出；等待后手动中断，因此不把该命令记为通过的验证。

## 下一步计划
- Task 2 添加共享 API 契约、错误码和权限类型。
- 后续任务再接入数据库迁移/RLS、Auth 中间件、组织 API、前端认证骨架及实际部署验收；本任务未执行这些内容。
