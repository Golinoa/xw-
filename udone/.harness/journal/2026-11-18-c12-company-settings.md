# C12 公司配置（R-SETTING-01）

日期：2026-11-18 · 卡片：P2-C12（S）· 出口：迁移 + 2 端点 + Web 设置页 + 三层测试全绿

## 结果

| 门禁 | 结果 |
|---|---|
| ESLint + CSS token | 通过 |
| `tsc --noEmit`（api）/ `vue-tsc --noEmit`（web） | 通过 |
| Vitest | 68 文件 / 888 用例全绿 |
| pgTAP | 44 文件全绿，`company_settings.sql` 10 断言 |
| 真实 PostgREST HTTP 集成 | 26 文件 / 418 用例全绿 |
| `schema:check` / `check:deploy` | 通过（52 个迁移） |
| `vite build` | 通过（输出到 Temp，绕开沙箱清空 dist 的限制） |

## 交付面

- 迁移 `20261118000003_company_settings.sql`：单租户单行配置表 + `get_company_settings()` +
  `update_company_settings(jsonb,int)`；没有表级写策略，只能走 RPC。
- 契约：`company-settings.ts`（配置数据、响应、更新请求）+ `ROUTES` 两条。
- API：`GET/PATCH /api/company-settings`；读给成员，写要 `settings.manage`。
- Web：`/company-settings` 单一设置页，导航入口「设置」；财务/权限规则变更弹二次确认。
- 测试：pgTAP 10 断言、API 单测 5 条、HTTP 集成 6 条。

## 两个真踩过的坑

1. **PostgREST 的 RPC 形状取决于函数声明**：`get_company_settings()` 返回单个 `jsonb`，
   PostgREST 给的是**对象**；`update_company_settings(...)` 用 `RETURNS TABLE`，给的是**数组**。
   服务层一开始都按数组取 `rows[0]`，于是读永远落到「空配置版本 0」的兜底分支。
   修法：`get` 同时兼容对象与数组。⇒ 规则：新 RPC 先看声明是标量还是 `TABLE`。
2. **`SELECT ... INTO` 在无行时把变量置 NULL**：第一次保存没有配置行，
   `current_version` 被置 NULL，直接拿去 `+1` 触发 not-null 约束。
   修法：查不到时显式复位为 0 / `{}`。

## 口径边界

- `companyName` 等字段是配置层的展示资料，**不是**租户标识；`organizations.name` 仍是注册名。
- Logo 上传按需求明确不做。
- 「影响财务或权限的配置需要操作密码或二次确认」取的是**二次确认**（页面弹窗 +
  服务端校验 `confirmed`），没有实现操作密码。
- 配置变更审计写 `public.audit_events.metadata.changedKeys`，只记变动的键，不记整份配置。
- 暂无独立审计日志页面，审计证据只能通过 pgTAP 与数据表查看（C10 尚未做）。
