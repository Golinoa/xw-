import { defineConfig } from '@playwright/test';

const externalBaseUrl = process.env.SMOKE_BASE_URL?.trim();

export default defineConfig({
  testDir: './tests/smoke',
  use: {
    baseURL: externalBaseUrl || 'http://127.0.0.1:8787',
    trace: 'off',
  },
  ...(externalBaseUrl ? {} : {
    webServer: {
      command: 'pnpm wrangler dev --local --port 8787',
      url: 'http://127.0.0.1:8787/login',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  }),
});
