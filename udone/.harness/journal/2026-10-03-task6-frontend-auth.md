# Task 6：前端认证与组织切换

## 今日完成

- 按 Task 6 新增 Supabase 浏览器客户端、认证状态 store、路由守卫、登录页、工作台和公司切换布局。
- 新增认证单元测试与 Playwright E2E：覆盖已登录状态、登录、退出、未登录重定向、公司切换及后续 API 的 `X-Organization-ID` 请求头。
- 增加 Vue SFC、路由、Supabase、Element Plus、Playwright 依赖和测试/构建配置；浏览器仅使用公开 publishable key，不包含 service role key。
- 验证通过：`pnpm typecheck`、`pnpm vitest run`（11 个文件、37 项）、`pnpm playwright test tests/e2e/auth.spec.ts`（2 项）、`pnpm build`。

## 关键决策

- 组织切换前调用服务端切换接口并核对返回的用户、公司和角色，再更新客户端上下文。其后的 API 请求发送选中组织头；服务端仍负责会话、成员关系、租户与权限校验。
- 认证表单使用 Supabase email/password 接口及邮箱字段。产品需求 R-AUTH-01 写的是“用户名和密码”，登录标识是否采用邮箱仍需产品/技术决策，当前实现不宣称解决了用户名映射。
- Playwright 使用虚构账号、组织和测试凭证，并拦截 Supabase/API 请求；未连接真实 Supabase、未验证真实用户或部署链路。

## 遇到的问题

- 初始应用入口未安装路由，且以字符串模板渲染 RouterView 在当前 Vue 运行时没有挂载页面；改为显式渲染 RouterView 后 E2E 页面正常。
- 根级 Vitest 无法自动解析 web workspace 依赖，补充 Vue 插件和 workspace 模块别名；Vite 构建通过，但 Element Plus 全量引入产生约 1.05 MB 的主 JS chunk 警告。
- 当前前端 scaffold 的打包与本地测试通过，不代表真实 Supabase、真实 API 或部署验收。

## 下一步计划

- 后续按授权执行 Task 7 的 Worker 部署与真实链路验收；部署前需提供有效 Supabase 配置并核实登录标识决策。
- 评估 Element Plus 按需引入或拆分主 chunk，再结合部署环境复核静态资源大小。
