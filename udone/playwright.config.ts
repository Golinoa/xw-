import { defineConfig } from '@playwright/test';

/**
 * 端口可覆盖：本机 4173 常被别的 dev server 占着（踩过两次，
 * 表现为「登录页上找不到邮箱输入框」——其实打开的是另一个项目的页面）。
 * CI 不设 `E2E_PORT`，仍走 4173 这个默认值。
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    /**
     * 单次点击/填写/等待元素的上限。
     *
     * Playwright 的默认动作超时是 **0（无限等）**：一个有问题的选择器不会报错，
     * 会把整个用例拖到总超时，然后只留下一句「Test timeout exceeded」——
     * 分不清是「按钮没出现」还是「点了没反应」。给个上限，失败信息才有指向。
     */
    actionTimeout: 15_000,
  },
  webServer: {
    command: `pnpm --filter @erp/web dev --host 127.0.0.1 --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture',
    },
  },
});
