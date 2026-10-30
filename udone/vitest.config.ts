import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      vue: resolve('apps/web/node_modules/vue'),
      'vue-router': resolve('apps/web/node_modules/vue-router'),
      '@supabase/supabase-js': resolve('apps/web/node_modules/@supabase/supabase-js'),
    },
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
    // 集成测试需要真实数据库与 PostgREST，走 vitest.integration.config.ts。
    exclude: [
      '**/.worktrees/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'tests/integration/**',
    ],
    /**
     * 默认并发（cpus-1，本机 16 核 → 15 个 fork）在这台机器上会让 worker
     * **启动**超时，而不是用例失败。实测同一份代码连跑两次：
     *
     *   默认：6s / 272 用例通过；接着 61s / 257 用例 + 1 个 unhandled error
     *   maxWorkers=6：6~7s / 272 用例通过，连续 3 次稳定
     *
     * 失败形态是 `Failed to start forks worker` → `Timeout waiting for worker
     * to respond`，**被吞掉的那个文件的用例根本没跑，而「Test Files 38 passed」
     * 照样报全绿**。也就是说默认并发下这个门禁每两次就有一次在漏跑 15 条断言，
     * 唯一信号是末尾那个 `Errors 1 error`——它太容易被当成抖动忽略。
     *
     * 限制峰值 fork 数是这段配置唯一的目的：不是为了让测试「更并行」或
     * 「更稳妥」，是因为不限并发时测得越快，漏跑得越多。
     */
    maxWorkers: 6,
  },
});
