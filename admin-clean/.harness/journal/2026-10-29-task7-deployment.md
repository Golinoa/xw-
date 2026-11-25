# Task 7 前端 · deployment 域（部署实例 / 版本升级历史 / 维护期）

- 日期：2026-10-29
- 分支：`feat/ops-console`（工作树 `D:/MYC/Coding/ERP-ops`）
- 应用：`admin/apps/web-antd`（Vue Vben Admin 5.7.0）
- 前置门禁：`admin/.harness/journal/2026-10-29-source-gate-task6-7.md`（已通过；**§4.4 私有化部署在 ERPNext 无对应物 → 不适用**）
- 参考源：**未打开** `D:/MYC/Coding/_refs/`。本域唯一真源是 `Docs/PRD.md` §6.8/§8 与
  `Docs/ops-api-contract.md` §3.7/§5.8/§6；未引入任何 ERPNext 代码或元数据（GPL-3.0）。
- 后端状态：`udone` 侧 ops deployment API **尚未实现**，本域全部走开发态契约桩。

## 1. 交付范围（仅可写路径内）

### API 客户端 `apps/web-antd/src/api/ops/deployment/`

| 文件 | 内容 |
| --- | --- |
| `endpoints.ts` | 路径集中、静态 `VITE_OPS_MOCK` 判定、幂等键/写请求配置、列表参数白名单（含 `status[]`） |
| `types.ts` | 契约字段逐字对齐；显式标注契约推导字段；不含任何凭据字段 |
| `instances.ts` | `fetchDeployments` / `fetchDeployment` / `createDeployment` / `updateDeployment` / `transitionDeployment` |
| `version-records.ts` | `fetchVersionRecords` / `createVersionRecord`（**只有读与追加**） |
| `rules.ts` | 状态动作表、`guardDeploymentAction`、维护期判定、升级登记校验、原因校验、固定文案 |
| `errors.ts` | `code` + `details.reason` → 中文文案与可恢复性（含 `VERSION_MISMATCH`） |
| `format.ts` | 状态/部署类型/升级结果标签、维护期视图、日期与版本号格式化、永久授权说明 |
| `dev-stub.ts` / `fixtures.ts` | `VITE_OPS_MOCK=true` 的契约桩 + **虚构**实例/版本/授权数据 |
| `README.md` | 域内约定与契约推导清单（覆盖原「未实现」说明） |

### 页面 `apps/web-antd/src/views/ops/deployment/`

- `instances.vue`（替换占位页）：服务端分页筛选（客户 / 环境类型 / 状态 / 当前版本 / 维护期到期日 / 产品）+ 当前版本 + 最后上报时间 + 维护期高亮 + 新建实例
- `detail.vue`（新增）：基本信息、维护期横幅、状态动作、升级登记、版本历史、关联授权、关联工单
- `components/`：`maintenance-banner.vue`、`version-history.vue`、`state-panel.vue`、
  `transition-confirm-modal.vue`、`version-record-modal.vue`、`create-instance-modal.vue`、
  `edit-instance-modal.vue`
- `composables/use-server-today.ts`：`GET /meta.serverTime` → `Asia/Shanghai` 业务日期
- `router/routes/modules/deployment.ts`：新增 `DeploymentInstanceDetail`
  （`/deployments/instances/:deploymentId`，`hideInMenu` + `activePath`）

开发态提示复用 `#/views/ops/billing/components/dev-data-notice.vue`（只读引用，未修改）。

## 2. 源码参考门 §5 约束的落点（可核对）

| 门禁约束 | 落点（文件 + 函数/组件） |
| --- | --- |
| §5.2 状态推进由动作驱动，界面不直写终态 | `rules.ts: deploymentStatusActions()` 只输出契约 §3.7 的动作；`instances.ts: updateDeployment()` 的可编辑字段**不含** `status`/`currentVersion`；`components/state-panel.vue` 只按该表渲染；`detail.vue: onTransitionConfirm()` 是唯一状态写入口 |
| §5.3 409 冲突刷新后重试，禁止本地覆盖 | `errors.ts: describeDeploymentError()` 对 409 一律 `shouldRefresh=true`（`VERSION_MISMATCH` 有专门文案「版本已变化，请刷新后重试」）；`detail.vue` 的 `onTransitionConfirm` / `onVersionSubmit` / `onEditSubmit` 与 `instances.vue: onCreate` 在 `shouldRefresh` 时重新拉取 |
| §5.4 超时/逾期一律读服务端字段 | `rules.ts: maintenanceStatus()` 不读浏览器时钟，`referenceDate` 由 `businessDateOf(meta.serverTime, meta.timezone)` 提供；取不到即 `unknown`（页面显示「无法判定」）。**代码中无 `Date.now()`/`dayjs()` 当前时间比较** |
| §5.1 金额只展示不运算 | 本域无金额字段；无任何金额格式化/运算代码 |
| §5.5 开发态数据必须可见标注 | 两个页面均渲染 `DevDataNotice`；`fixtures.ts` 全部为虚构客户/实例/版本/授权号 |
| 契约 §3.7 禁用列（安全红线） | `types.ts` / 表单 / fixtures 均无 SSH、口令、token、connection string、安装包地址；`environmentRef` 明确「可读标识，不是地址」 |
| PRD §6.6 永久授权 ≠ 永久更新 | `rules.ts: PERPETUAL_NOT_PERPETUAL_UPDATE_NOTE` + `format.ts: deploymentMaintenanceNotice()`（唯一文案真源）→ `components/maintenance-banner.vue` 渲染（`data-testid="deployment-perpetual-note"`）；`detail.vue` 的 `perpetualLicenseNos` 只用于「补充说明」，**不参与**维护期判定 |

## 3. 状态覆盖（硬性验收）

| 状态 | 列表页 | 详情页 |
| --- | --- | --- |
| loading | `Table :loading` | `Spin` |
| empty | `Empty`「当前筛选条件下没有部署实例」 | 无实例 → `Result 404`；无授权/无工单 → `Empty` |
| error | `deployment-list-error` + 重试 | `deployment-detail-error` + 重新加载 |
| validation | 新建弹窗必填校验；400 映射「提交内容有误」 | 升级登记校验（`validateVersionRecordInput`）、编辑校验、400 映射 |
| permission-denied | `deployment-permission-denied`（且不发请求） | `deployment-detail-permission-denied`（且不发请求） |
| conflict | 409 → 「数据已变化，请刷新后重试」+ 重新拉取 | 同左（含 `VERSION_MISMATCH` 专门文案） |
| destructive-confirm | —（列表无破坏性动作） | `transition-confirm-modal`：影响摘要 + 必填原因 + 勾选确认，未确认不发请求 |

## 4. 单元测试

`apps/web-antd/src/views/ops/deployment/__tests__/`（4 文件 / 26 用例）

| 文件 | 覆盖 |
| --- | --- |
| `maintenance-state.test.ts` | 未到期 / 30 天内 / 已到期 / 无法判定四分支；30 天边界；`businessDateOf` 跨时区不差一天；横幅三档 `data-testid` 分支；永久授权说明出现与否 |
| `version-history-readonly.test.ts` | 版本记录 API 只有读与追加（无 update/delete）；历史面板 0 个按钮、无「操作」列、标注「仅追加/不可修改」；升级登记前置校验（`version_mismatch`/同版本/缺日期） |
| `permission-denied.test.ts` | 无 `deployment.read`：列表/详情只渲染无权限说明、不渲染实例数据、**不发请求**；有权限时正常拉取并渲染（证明门禁不是静态隐藏） |
| `destructive-confirm.test.ts` | 未填原因 / 未勾选 → 不发事件；通过后 trim 原因；状态动作表（`active` 只有维护/退役、`retired` 无动作、缺权限禁用）；`go_live` 缺上线日期守卫；详情页点「退役」只开弹窗、未确认 `transitionDeployment` 零调用，确认后恰好 1 次 |

## 5. 契约推导待确认项（实现已按此落地，需后端对齐）

| # | 项 | 本实现的默认值 | 影响 |
| --- | --- | --- | --- |
| D-01 | §5.8 无状态流转端点 | 新增 `POST /deployments/{id}/transition`（`action`+`reason?`+`version`），与 customer/contract 同形态 | 后端须实现，否则页面只能读不能推进状态 |
| D-02 | 列表筛选 `deploymentType` | 透传 `deploymentType`（实例自有列） | 需后端加入白名单 |
| D-03 | 列表筛选 `productId` | 透传 `productId`（需经授权关联聚合）；页面已标注「契约推导」 | 后端不支持时该条件静默不生效 |
| D-04 | 「最后上报时间」无字段 | 取最近一条版本记录的 `createdAt`（`lastVersionRecordAt`，契约推导），列头用 tooltip 说明口径 | 若产品需要真实心跳，需新增 `last_reported_at` 列与上报链路 |
| D-05 | 维护期预警窗口 | 前端常量 `MAINTENANCE_WARNING_DAYS = 30`（仅影响高亮，不影响业务判定） | 若接入 `settings.overview.expiryWindowDays` 需后端下发配置 |
| D-06 | 维护期「今天」来源 | `GET /meta.serverTime` + `timezone` | 若 `/meta` 不可用，维护期状态降级为「无法判定」（不误报） |
| D-07 | 升级结果对当前版本的影响 | `succeeded` 推进到 `toVersion`；`failed`/`rolled_back` 保持原版本（桩内约定） | 需后端确认 `rolled_back` 是否回写 `currentVersion` |
| D-08 | `deployment.write` 是否入高风险清单 | 当前不在 `OPS_HIGH_RISK_PERMISSIONS`，页面按「破坏性动作」呈现（确认+原因+勾选），`highRisk` 标记由 `isHighRiskPermission()` 计算 | 后端若升级为高风险，页面自动切换为高风险呈现，无需改页面 |

## 6. 验收命令结果（本机实测）

见文末「验收输出」小节（含 support 域并行开发造成的门禁冲突说明）。

## 7. 需要 leader 知道的风险

1. **`transition` 端点与两个筛选参数是前端推导**（D-01/D-02/D-03）：后端若按 §5.8 原样实现，
   状态推进与产品/环境筛选会直接失效。需在 T-11 任务书里补齐。
2. **维护期判定依赖 `GET /meta`**（D-06）：多一次请求；`/meta` 故障时维护期高亮降级为「无法判定」
   （宁可不报也不误报），运营需知道这不是数据缺失。
3. **破坏性动作确认未接 step-up 认证**：契约 U-09 明确 v1 只强制 `reason` + 审计 + 前端确认，
   本域按此实现；`deployment.write` 是否为高风险仍待产品确认（D-08）。

## 8. 验收输出（2026-10-29 实测，四条命令逐条）

```
$ corepack pnpm --filter @vben/web-antd typecheck
> vue-tsc --noEmit --skipLibCheck
TYPECHECK_EXIT=0

$ corepack pnpm --filter @vben/web-antd test:unit
 Test Files  47 passed (47)
      Tests  321 passed (321)
   Duration  38.62s
（deployment 域：4 文件 / 26 用例全部通过）

$ corepack pnpm run lint:check
> oxlint --threads=2 apps/web-antd && eslint apps/web-antd/src ... && stylelint ...
Found 0 warnings and 0 errors.
Finished in 2.7s on 273 files with 226 rules using 2 threads
lint exit=0

$ corepack pnpm run format:check
Checking formatting...
All matched files use the correct format.
Finished in 2536ms on 1197 files using 2 threads
format exit=0
```

**并行开发说明**：验收过程中有三轮 transient 失败全部来自 `src/api/ops/support/**`
（同一批次并行实现的 support 域，本任务不可写），均已由 support 侧修复；
最终四条门禁在完整工作树上同时为绿。deployment 域内 `typecheck` / `eslint` / `oxfmt`
零告警（首轮 eslint 报的 17 条 `perfectionist/*` 与 `unicorn/*` 已用
`eslint --fix` 修在本域文件内，未触碰任何公共配置）。


