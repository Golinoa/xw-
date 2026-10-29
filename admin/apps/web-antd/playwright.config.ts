/**
 * 运营后台 e2e（Playwright）配置。
 *
 * 定位：**契约桩验证**，不是真实后端集成验收。
 * - `chromium-stub`（端口 5666，`VITE_OPS_MOCK=true`）：走 `src/api/ops/__stub__` 的
 *   开发态契约桩，验证登录/登出/守卫/菜单呈现等前端行为。
 * - `chromium-http-contract`（端口 5667，`VITE_OPS_MOCK=false`）：axios 走真实 HTTP
 *   路径，由用例用 `page.route` 回放契约响应，用于验证「权限子集」场景
 *   （桩固定授予全部动作码，无法覆盖无权限分支；见
 *   `.harness/journal/2026-10-29-test-infra-ci.md` 的缺口记录）。
 *
 * 首期只启用 chromium：够用且省资源。
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

/** 契约桩实例，对齐 `apps/web-antd/.env.development` 的 `VITE_PORT=5666`。 */
const STUB_BASE_URL = 'http://localhost:5666';

/** 契约响应实例：不启用应用内桩，网络层由用例拦截。 */
const HTTP_CONTRACT_BASE_URL = 'http://localhost:5667';

/**
 * 浏览器通道：默认使用 Playwright 自带 chromium（CI 用 `playwright install chromium` 安装）。
 * 本地若无法下载二进制（离线/限速），可用 `PLAYWRIGHT_CHANNEL=chrome` 复用本机已装 Chrome，
 * 仍属 Chromium 内核，但**不是** CI 使用的同一构建——这种运行结果需在文档中标明。
 */
const channel = process.env.PLAYWRIGHT_CHANNEL ?? undefined;

export default defineConfig({
  testDir: './e2e',
  // 用例文件统一用 `*.e2e.ts`：`pnpm --filter @vben/web-antd test:unit` 在包目录内
  // 单测侧已在 `apps/web-antd/vitest.config.ts` 里排除 `**/e2e/**`；
  // 这里仍用 `*.e2e.ts` 命名，是为了让「这是 e2e」在文件名上就能看出来。
  testMatch: '**/*.e2e.ts',
  // 用例之间通过 storageState/cookie 隔离，不依赖执行顺序
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  // 本地默认 undefined 会按 CPU 核数起最多 8 个 worker，同时打两个 dev server
  // （5666 桩 / 5667 契约回放）。首次访问触发 Vite 依赖预构建并 reload，
  // 并发过高时导航会被 `net::ERR_ABORTED` 打断，表现为随机的 goto 超时。
  workers: CI ? 2 : 4,
  // 首次编译 + 预构建实测可到 20s 以上，30s 余量不足；这是构建成本，不是产品慢。
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]]
    : [['list']],
  use: {
    baseURL: STUB_BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // 不录制视频：视频渲染依赖额外下载的 ffmpeg 二进制，失败截图 + trace 已足够定位
    video: 'off',
  },
  projects: [
    {
      name: 'chromium-stub',
      testDir: './e2e/stub',
      use: { ...devices['Desktop Chrome'], channel },
    },
    {
      name: 'chromium-http-contract',
      testDir: './e2e/http',
      use: {
        ...devices['Desktop Chrome'],
        baseURL: HTTP_CONTRACT_BASE_URL,
        channel,
      },
    },
  ],
  webServer: [
    {
      // 桩实例：覆盖 .env.development 的 VITE_OPS_MOCK=false（Vite 的 process.env 优先级更高）
      command: 'pnpm -F @vben/web-antd dev',
      env: { VITE_OPS_MOCK: 'true' },
      url: STUB_BASE_URL,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // 契约响应实例：用 exec 直接调 vite 才能把 `--port` 传给 vite
      // （`pnpm run dev -- --port` 会把 `--` 原样透传，端口不生效）
      command:
        'pnpm -F @vben/web-antd exec vite --mode development --port 5667 --strictPort',
      env: { VITE_OPS_MOCK: 'false' },
      url: HTTP_CONTRACT_BASE_URL,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
