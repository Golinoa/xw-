# e2e 基建与 CI —— 阶段 0 执行记录

**日期：**2026-10-29
**范围：**`~admin`（`D:/MYC/Coding/ERP-ops`，分支 `feat/ops-console`）
**对应推进计划：**[2026-10-29-ops-console-wave-plan.md](../docs/exec-plans/active/2026-10-29-ops-console-wave-plan.md) 阶段 0

---

## 一、接手的真实状态（与前序记录的差异）

前序会话在额度中断前已写入 `playwright.config.ts` 与 3 个 e2e 用例文件，但**从未执行过**：浏览器二进制未下载、journal 未写、Gitee 流水线未建。本节纠正「已交付」的误判。

| 项 | 接手时 | 现在 |
| --- | --- | --- |
| `playwright.config.ts` | 已存在（双 project 设计） | 保留，未改动 |
| e2e 用例 | 4 个文件已写，0 次执行 | **6 例执行通过** |
| chromium 二进制 | 缺失（仅 `__dirlock`） | 已装 `chromium-1248` |
| `test:e2e` 根命令 | 假绿（`Tasks: 0 total`） | 真实调度（`Tasks: 1 successful`） |
| Gitee 流水线 | 已存在（仓库根 `.workflow/`，4 条） | 已存在，补齐浏览器镜像配置 |

---

## 二、执行的命令与真实结果

所有命令前置：`export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"`，工作目录 `admin/apps/web-antd`。

```
1) playwright install chromium（直连 CDN）
   结果：8 分 40 秒无任何输出 → 判定网络卡死，终止

2) PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
   playwright install chromium
   结果：成功，安装 chromium-1248 / chromium_headless_shell-1248 / ffmpeg-1013 / winldd-1007
   结论：国内环境必须指定镜像源，否则默认 CDN 无法完成下载。已写入 CI 配置。

3) playwright test --project=chromium-stub
   结果：5 passed (28.6s)

4) playwright test --project=chromium-http-contract
   结果：1 passed (21.9s)

5) playwright test（全量，真实 chromium）
   结果：6 passed (31.5s)

6) pnpm run test:e2e（根命令，经 turbo 调度）
   结果：Tasks: 1 successful, 1 total；6 passed (29.7s)
   意义：此前该命令 exit 0 但 0 个任务执行，属假绿；现已真实执行。

7) 质量门复核
   typecheck  PASS
   test:unit  23 files / 171 tests passed
   lint:check 0 warnings, 0 errors
```

### 备用通道（记录备查）

本地若无 chromium 二进制，可用 `PLAYWRIGHT_CHANNEL=chrome` 复用本机 Google Chrome 跑同一套用例——已实测 6 例全通过。但那是**不同的浏览器构建**，结果不能等同于 CI 结果，需在交付说明中标注。CI 一律使用仓库锁定的 chromium 版本。

---

## 三、顺带修复的真实缺陷：页面标题渲染成 i18n key

### 现象
登录后首页标题显示 `ops-shell.nav.overview` 而非「运营总览」。侧边栏菜单 11 项**均正常**（实测确认），只有页面内标题异常。

### 根因
1. `apps/web-antd/src/router/routes/modules/*.ts` 用 `title: $t('ops-shell.nav.xxx')` 声明标题；
2. 路由经 `import.meta.glob('./modules/**/*.ts', { eager: true })` **静态引入**；
3. `bootstrap.ts` 第 17 行静态 `import { router } from './router'`，而 `setupI18n()` 在第 44 行才 `await` 执行；
4. 因此 `$t()` 在 i18n 就绪前求值，返回 key 本身（`meta.title` 实际存的是 key）。这与上游 Vben 写法一致，属上游固有的求值顺序特征——消费方必须自行翻译；
5. `views/ops/_shared/placeholder-page.vue` 直接渲染 `{{ title }}`，未翻译。

### 修复
`placeholder-page.vue` 增加 `displayTitle = computed(() => title ? $t(title) : '')`，模板改用 `displayTitle`。

该写法幂等：若将来加载顺序变化导致 `meta.title` 已是译文，`$t()` 找不到对应 key 会原样返回，两种情况下都正确。

### 防回归
在 `e2e/stub/auth.e2e.ts` 的登录用例中加两条断言：
- `getByRole('heading', { level: 2, name: '运营总览' })` 可见；
- `getByText('ops-shell.nav.overview')` 计数为 0。

### 排查范围确认
全 `src` 仅 `placeholder-page.vue` 存在直接渲染 `meta.title`；`bootstrap.ts:66` 的 `document.title` 已用 `$t()`；业务页（客户/合同/账款）标题为硬编码中文，无此问题。

---

## 四、e2e 覆盖清单（当前）

| 文件 | 用例 | 验证的是什么 |
| --- | --- | --- |
| `e2e/stub/auth.e2e.ts` | 正确凭据进首页 | 会话建立 + 默认首页 + 桩条幅可见 + 标题已译 |
| | 错误凭据内联报错 | 错误映射为可读中文、输入不被清空、未产生会话 |
| | 未登录访问受保护路由 | 重定向 `/auth/login?redirect=` 且 redirect 可解码回原路径 |
| | 登出后会话清理 | 登出跳登录页、再访问受保护路由仍被拦 |
| `e2e/stub/access.e2e.ts` | 具备 `customer.read` | 客户菜单可见、列表页可进入 |
| `e2e/http/permission.e2e.ts` | 仅 `customer.read`（HTTP 契约回放） | 客户菜单可见、账款菜单不可见、直达 URL 落 404 |

**覆盖缺口（需后端就绪后补）：**桩固定授予全部 40 个动作码，「同一账号部分权限」只能靠 `e2e/http` 的 `page.route` 回放近似；真实后端的权限子集、账号停用、无运营成员身份三类拒绝路径未验证。

---

## 五、未完成项

1. **Gitee 流水线**：仓库根 `.workflow/` 下已有 4 条流水线（`ci.yml` 管 udone、`frontend-quality.yml` 管 admin、两条 release）。本次仅修正 `frontend-quality.yml` 的 e2e 阶段——原配置未指定 `PLAYWRIGHT_DOWNLOAD_HOST`，按本机实测会在 CI 上卡死。触发分支已核对为 `main`（`origin/HEAD -> origin/main`）。
   **仍待人工完成**：文件存在不等于分支保护已启用。需在 Gitee 仓库「管理 → 分支设置」为 `main` 勾选「要求流水线通过」，并发起一次真实 PR 验证拦截生效。本会话无法执行。
2. **依赖审计**：20 high + 2 critical 未处理，分级结论见阶段 0 另一份记录。
3. **e2e 未纳入 `quality:check`**：当前 `quality:check` 含 build 但不含 e2e（e2e 耗时长、依赖浏览器）。是否纳入由 CI 阶段单独执行，见流水线配置。

---

## 六、复现指引

```bash
export PATH="/d/MYC/A.soft/nodejs-24.20.0:$PATH"
cd admin

# 首次需装浏览器（国内必须用镜像）
cd apps/web-antd
PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
  corepack pnpm exec playwright install chromium
cd ../..

# 跑 e2e
corepack pnpm run test:e2e
```
