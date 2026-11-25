# 2026-10-30 单测假失败根治 + 双端看板改造

## 0. 结论速览

- **单测「全过但 exit 1」已根治**：根因是 vitest fork 并发过高（不是断言失败）。改 `admin/vitest.config.ts` 限 4 个 fork，连跑两轮 `47 文件 / 321 用例 / exit 0`。
- **交付状态上板**：`D:/MYC/Coding/XW-ERP/dev-board.html` 从「只有业务端」改造为双端看板（任务带 `side`、新增「双端对照」视图）。
- 本轮前我报的「已根治」是**错的**——上次只修了 `stub-contract.test.ts` 一个文件，同一症状随后在 `tenant-errors.test.ts` 复现。

## 1. 单测假失败：从「改一个文件」到「改并发」

### 症状
`pnpm --filter @vben/web-antd test:unit` 报 `46 passed / 311 passed` 但 `exit 1`，末尾：

```
Error: [vitest-pool]: Failed to start forks worker for test files .../tenant-errors.test.ts
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
```

### 为什么上次的修法是错的
上次把 `stub-contract.test.ts` 的 `resetModules` + 多次动态导入改成 `beforeAll` 单次导入，失败消失了，于是记成「根治」。这次另一个文件中了同一招，说明改的是**某一个 worker 的启动成本**，不是**worker 启动超时的成因**。

### 真因
- 本机 16 核 / 16GB，vitest 默认 `maxForks = CPU 核数 - 1` → **15 个 fork 同时起**。
- 47 个测试文件每个都要独立解析一遍 vue / antd / vben 的模块图（日志：`import 102.33s` 累计）。
- 峰值内存 + 磁盘争用把 worker 首次响应推过 vitest 内置超时（该超时在 4.1.7 里不可配，源码中无 `startupTimeout` 选项）。
- 因此「哪个文件失败」是随机的：`stub-contract`、`tenant-errors` 各中一次。

### 修法
`admin/vitest.config.ts`：

```ts
poolOptions: { forks: { maxForks: 4, minForks: 1 } },
```

### 验证
| 轮次 | 结果 |
| --- | --- |
| 第 1 轮 | 47 passed (47) / 321 passed (321) / `exit 0` |
| 第 2 轮 | 47 passed (47) / 321 passed (321) / `exit 0` |

> 教训：**「复跑变绿」不是证据，连续两轮同结果才是。** 把偶发失败记成已修，是比失败本身更贵的错误——它会让后续所有「门禁全绿」都失去可信度。

## 2. 双端看板改造（`XW-ERP/dev-board.html`）

原看板只承载业务端（udone）。改造要点：

| 项 | 做法 |
| --- | --- |
| 端维度 | `tasks` / `versions` 增加 `side: 'biz' \| 'admin'`；顶栏「双端 / 业务端 / 运营后台」筛选 |
| 双端基线 | 两栏并排，各自写实测数字与门禁，运营后台侧标注「后端 0 行」 |
| 双端对照（新视图） | 域级矩阵（前端 API 函数 / 页面项 / 前端状态 / 后端实现 / 说明）+ 阻塞联调四件事 + 「谁在等谁」 |
| 数据隔离 | localStorage 键升到 `xwerp_board_v2`，`SEED_VERSION` 2 → 3 |
| 迁移 | **v2 键为空时回退读 `xwerp_board_v1`**，否则用户此前拖过的卡片会静默丢失；缺 `side` 的旧条目统一归 `biz` |

### 浏览器实测（Playwright + 真实 chromium，非肉眼）
- 双端模式 `60` 任务（业务 38 / 运营 22）；切运营后只剩 22 张卡，版本下拉同步收敛为 6 个 a0.x
- 双端对照：9 行域矩阵，合计 `95` 个 API 函数 / `54` 页面项
- 版本筛选 `a0.3` → 看板 10 张卡（与 seed 一致）
- 420px 视口 → 看板 1 列，无横向溢出
- 迁移用例：造一份 v1 数据（含自加任务）→ 写入 v2、`my-own` 保留、`side=biz`、缺 side 条目 0
- 控制台错误：`无`（补了 data-URI favicon，原来有一个 404）

### 上板的数字全部现测
`typecheck 0 错` / `单测 47 文件 321 用例` / `lint 0 警告 0 错误` / `format 全匹配` /
`build 11 tasks` / `dist.zip 1.5 MB` / `dev-stub 分块 0` / `e2e 3 spec 6 例` /
`41 新增 / 43 修改 / 7 删除`（43 含本次 vitest.config.ts）。

## 3. 双端协调事实（写进看板，避免互相以为对方没动）

- 运营后台 8 域前端已就绪，95 个 API 函数全部指向不存在的后端。
- 业务端已接单并产出 `udone/Docs/superpowers/plans/2026-10-30-ops-backend-implementation.md`（Wave 0 四项前置 + T-01~T-03）。
- 代码未开始：`udone/apps/api/src/modules/` 仍只有 customers / finance / finance-applications / members / orders / suppliers。

## 4. 未做

- 未提交 admin 工作树（41/43/7 仍脏）。`vitest.config.ts` 是本次新增的唯一非文档代码改动。
- 依赖审计（critical 2 / high 20）未清理，仍建议单独立项。
