/**
 * ERP 前台（Vben 骨架）E2E 配置。
 *
 * 定位：**契约桩验证**——只证明前端的渲染、守卫与请求体正确，不冒充后端集成。
 * 后端行为由 `udone` 的 pgTAP 与 HTTP 集成测试负责。
 *
 * 两条硬约束（与 udone 的 E2E 保持一致）：
 * 1. 端点路径不动：`/auth/v1/*`（Supabase）与 `/api/*`（业务）由用例用 `page.route` 回放。
 * 2. 回放的响应体一律先过 `@erp/contracts` 的 schema（见 `e2e/support/session.ts`），
 *    契约漂移时用例当场红，而不是长期绿着喂错字段给界面。
 *
 * 浏览器：默认用 Playwright 自带 chromium（CI 需 `npx playwright install chromium`）。
 * 本机二进制与 `@playwright/test` 版本不匹配时，用 `PLAYWRIGHT_CHANNEL=chrome`
 * 复用本机已装 Chrome——仍是 Chromium 内核，但**不是** CI 同一构建，
 * 这种运行结果需在文档里标明。
 */
import { defineConfig, devices } from '@playwright/test';

/**
 * 本机若设置了 `HTTP(S)_PROXY`（企业代理 / 沙箱），Playwright 的 webServer 探活会走代理，
 * 把「端口无人监听」误判成「服务已就绪」，随后用例连到不存在的服务上。
 * 这里为回环地址显式绕过代理；已设置其它值的环境不被覆盖。
 */
process.env.NO_PROXY ??= 'localhost,127.0.0.1,::1';
process.env.no_proxy ??= 'localhost,127.0.0.1,::1';

const CI = Boolean(process.env.CI);

/** 端口可覆盖：本机 5330 也可能被别的 dev server 占着（踩过，表现为登录页控件全找不到）。 */
const PORT = Number(process.env.E2E_PORT ?? 5330);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  // 用例文件统一 `*.e2e.ts`，与单测（vitest）分开，文件名上就能看出这是端到端。
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // 同时只开一个 dev server；并发过高时导航会被首次依赖预构建触发的 reload 打断，
  // 表现为随机的 goto 超时（udone 侧踩过，现象与「选择器写错」极像）。
  workers: CI ? 2 : 2,
  // 首次编译 + 预构建实测 6s 起，但给足构建成本，别把慢误判成产品缺陷。
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    // 单次动作上限：Playwright 默认是 0（无限等），选择器写错只会得到
    // 一句「Test timeout exceeded」，分不清是元素没出现还是点了没反应。
    actionTimeout: 15_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env.PLAYWRIGHT_CHANNEL ?? undefined,
      },
    },
  ],
  webServer: [
    {
      /**
       * 不走 `pnpm -F`：本机 pnpm 会被残留 `_tmp_*` 卡住（见项目记忆），
       * 直接调 vite 的 bin 更稳，也不会触发任何安装动作。
       */
      command: `node ../../node_modules/vite/bin/vite.js --mode development --port ${PORT} --strictPort`,
      url: BASE_URL,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      /**
       * 凭据用固定夹具：`.env.local` 里可能有真实 Supabase 地址，
       * 而 Vite 的 process.env 优先级最高，这里显式压掉，保证用例可复现。
       * `VITE_API_BASE_URL` 置空 ⇒ 业务请求走同源相对路径，由 `page.route` 接管。
       */
      env: {
        VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
        VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture',
        VITE_API_BASE_URL: '',
      },
    },
  ],
});
