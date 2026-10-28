# Task 4: Worker Auth 中间件和统一错误处理

## 今日完成

- 在 API 中接入请求 ID 中间件、Auth 与 Permission 中间件、统一错误处理器和 health 路由。
- 添加 6 个中间件测试，覆盖缺失/无效 Bearer token、已验证身份、权限拒绝、request ID 保留及隐藏内部异常细节。
- 验证命令 `corepack pnpm vitest run apps/api/src/middleware && corepack pnpm typecheck && corepack pnpm vitest run` 全部通过：中间件 10/10、Web/API typecheck 通过、全套 23/23。`git diff --check` 通过。\n- 独立审查未发现 Critical；按反馈增加 malformed Authorization、成功响应 request ID 与 health request ID 用例。审查原记录见 `2026-10-03-task4-code-review.md`。

## 关键决策

- **仓库事实**：Task 2 的共享契约定义了 AuthContext、Permission 和 ApiErrorBody；API 通过注入的 `AUTH_VERIFIER` 使用这些契约，不在中间件创建 Supabase client，也不记录 bearer token。
- **范围裁定**：`packages/contracts/package.json` 没有 `main`/`exports`，因此 `@erp/contracts` 无法被当前 TypeScript/Vitest 解析。为遵守 Task 4 的文件范围，本 Task 在 API 源码中相对引用共享契约源码，未改 Task 4 未列出的 package manifest。若该取舍不适合后续打包，应单独补齐共享包入口；当前验证覆盖 typecheck 与 Vitest，未运行 Wrangler 部署。
- **方案决定**：具体角色到权限的映射由注入的 verifier 决定；计划未定义矩阵，本 Task 不推断或固化角色规则。\n- **审查裁定**：生产 Worker verifier binding/factory 由 Task 7 的 Supabase/Worker 部署接线完成，本 Task 保留注入接口；当前任务验证为注入 verifier 的中间件，不声称生产认证链路已可用。若 Task 7 未提供适配器，受保护请求会因 verifier 缺失返回 `INTERNAL_ERROR`/500。

## 遇到的问题

- `@erp/contracts` package entry 缺失，见上面的范围裁定；当前通过源码相对引用完成编译和测试。
- `origin/main` 本地跟踪分支已失效；本 Task 仅做本地提交，不推送。\n- 初次审查发现 malformed header / 成功响应 request ID 测试不足，已在本 Task 补测并通过。

## 下一步计划

- 后续任务提供真实 Supabase Auth verifier 及权限查询适配，并确认 `@erp/contracts` package entry/exports 的处理方式。
- Task 7 配置 Worker 环境绑定后，再进行实际 Worker 请求/响应验收。
