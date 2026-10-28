# Task 2：共享 API 契约

## 今日完成

- 新增共享 `AuthContext`、六个 API 错误码及其字面量联合类型、四项权限常量及权限联合类型。
- 新增 `ApiErrorBody`、成功/失败可辨识的 `ApiResponse<T>`，并从 contracts barrel 导出。
- 为契约字段、常量和 barrel 导出新增测试；全仓库 Vitest 8 项通过，web/API `pnpm typecheck` 通过，contracts 源码与测试的严格 `tsc` 检查通过。

## 关键决策

- 错误码及权限以 `as const` 常量映射定义，联合类型从常量值派生，减少字符串重复；`ApiErrorBody.code` 保持计划规定的 `string`。
- `ApiResponse<T>` 使用 `success` 字面量区分 `{ data }` 与 `{ error }`。
- Ruling: 不修改 `packages/contracts/package.json` — Task 2 文件范围只列出 `src` 文件，而 manifest 导出映射未列入 — cost if wrong: 后续应用若通过裸包名 `@erp/contracts` 导入，可能需要先补根导出映射。

## 遇到的问题

- 现有 contracts manifest 仅声明包名和 ESM，未声明 `exports` 或 `types`。本 Task 测试通过相对路径导入，未验证下游裸包名解析；这是待后续集成确认的边界。

## 下一步计划

- 后续 API/Web 任务开始从 `@erp/contracts` 消费类型前，确认并验证包根入口映射。
- 后续 Task 3 继续建立身份 schema、迁移和 RLS；本 Task 未实现后续任务内容。
