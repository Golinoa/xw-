import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  use: {
    baseURL: 'http://127.0.0.1:4173',
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
    command: 'pnpm --filter @erp/web dev --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    env: {
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_fixture',
    },
  },
});
