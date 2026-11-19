# 2026-11-19 新六页界面的 E2E 覆盖 + 一个整页白屏

## 为什么做这一格
C6–C12 的六个界面（余额 / 报表 / 审计 / 通知 / 公司配置 / CRM）此前只有
类型检查与生产构建保过——「按钮点了会不会发请求、请求有没有带版本号」全靠读代码。
D2 的 `e2e_gate` 要跑的就是这套用例，用例覆盖不到新页面，门禁就是半盲的。

## 抓到并修掉的真缺陷
`apps/web/src/views/reports/ReportListView.vue` 写了 `<a-table title="供应商统计">`。
ant-design-vue 的 Table 把 `title` 当**渲染函数**调用（`title(mergedData.value)`），
传字符串 → 挂载时 `TypeError: title is not a function`，整个 `/reports` 白屏。

- `vue-tsc` 不报：`title` 的 prop 类型是 `any`（VNodeChild | Function 联合没约束住）。
- 生产构建不报：这是运行时错误。
- 只有真浏览器打开这一页才炸。修复：改用普通 `.section-title` 元素。

## 新增用例
`tests/e2e/admin-surfaces.spec.ts`，6 条，全部真浏览器 + 真点击：
1. 余额页：1,000 + 4,000 − 1,500 − 500 = 3,000，口径算错就红。
2. 报表页：订单数来自接口、供应商表渲染、CSV 导出下载文件名。
3. 审计页：列表、facets 请求各一次、页面上不存在删除/编辑入口（只读）。
4. 通知页：标记已读只提交选中的 id（`{ ids: ['notification-1'] }`）。
5. 公司配置：保存带 `expectedVersion`，旧版本再存被 409 拒并提示刷新。
6. CRM 公海：认领带版本号，认领后归属当前用户。

桩沿用 `support/api-stub.ts`，只加了一个 `handlers` 扩展点（新模块端点不往既有的
长 if 链里塞分支）；每个响应仍先过 `@erp/contracts`，`violations` 与 `unhandled`
在每个用例末尾都断言为空。

## 配置改动
`playwright.config.ts` 的端口支持 `E2E_PORT` 覆盖。本机 4173 被别的 dev server 占着
（打开的是另一个项目，表现为「登录页找不到邮箱输入框」），而 `reuseExistingServer`
会把那台服务当成自己的。CI 不设该变量，仍是 4173。

## 门禁
- `playwright test`（全量 6 个 spec）：**16 通过 / 1 跳过**（CAPTCHA 缺 key）
- `vue-tsc --noEmit`、`eslint tests/e2e`、`prettier --check`、CSS token、生产构建：全过

## 没做的
流水线实跑结果仍看不到（私有仓库，匿名 API 404）。`main` 已推到 `dc2d874`，
需要在有权限的页面确认 `e2e_gate`。
