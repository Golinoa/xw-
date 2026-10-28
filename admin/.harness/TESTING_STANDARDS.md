# 测试约束

- 纯领域规则、格式化、状态转换、API 输入映射和 UI 单元逻辑用快速单元/契约测试。
- Hono 鉴权、运营权限、接口错误和命令幂等在后端集成测试；RLS、grants、约束和事务必须使用 PostgreSQL 数据库测试验证，mock 不能证明 RLS。
- Playwright 覆盖关键用户流程：运营登录拒绝/允许、客户合同、分次收款、授权审批和同步、私有化台账、售后工单。
- 每个变更按风险覆盖正常、非法输入、缺失/过期身份、权限拒绝、冲突/重复提交和依赖失败场景。
- 前端测试显式验证 loading、empty、error、validation、permission-denied 和 destructive-confirm 状态。
- 使用可重复的虚构客户、合同、授权和收款数据；禁止真实个人/支付/生产信息进入 fixture。
- 测试应断言外部可见行为和安全不变量，不依赖 arbitrary sleep；用可控时钟或明确状态等待。
- 报告具体运行命令、环境和结果。构建/typecheck 不等于运行时验收；mock API 不等于真实 Supabase/RLS 验收。
- 不设置未经同意的全仓覆盖率百分比；变化风险由测试矩阵说明，后续如新增阈值需说明口径与执行命令。
- 前端静态门禁使用固定 Node/pnpm 版本，运行 `pnpm run quality:check`：含 `web-antd` 格式、Oxlint/ESLint/Stylelint、Vue typecheck、Vitest、生产构建、许可证、secret、构建产物和完整 lockfile audit。
- `pnpm run quality:negative` 临时制造 lint 解析错误、TypeScript 类型错误、虚构 secret 与未批准许可证，并断言各自命令非零退出；同时验证不兼容 Node/pnpm 版本及 PR workflow secret/environment 白名单会被拒绝。canary 在 `finally` 中清理，不留在仓库。
- P0 业务流程 Playwright、真实 Auth/API、PostgreSQL/RLS 和 staging 验收属于后续业务任务；本地前端质量门与 Vben 模板单测不替代这些证据。
