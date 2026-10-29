import Vue from '@vitejs/plugin-vue';
import VueJsx from '@vitejs/plugin-vue-jsx';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [Vue(), VueJsx()],
  test: {
    environment: 'happy-dom',
    // 默认 maxForks = CPU 核数-1（本机 16 核 → 15 个 fork）。每个 fork 都要独立
    // 解析一遍 vue/antd/vben 的模块图，峰值内存与磁盘争用会把 worker 启动推过
    // vitest 内置的响应超时，表现为「用例全过但 exit 1 + Timeout waiting for
    // worker to respond」，且命中文件每次不同（stub-contract / tenant-errors 都中过）。
    // 限制并发是根因层面的修法：总耗时变化不大，但不再有假失败。
    poolOptions: {
      forks: { maxForks: 4, minForks: 1 },
    },
    environmentOptions: {
      happyDOM: {
        settings: {
          // happy-dom v20+ disables JS evaluation by default (security fix).
          // Treat disabled script loading as success to preserve test behavior.
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    exclude: [
      ...configDefaults.exclude,
      '**/e2e/**',
      '**/dist/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/node_modules/**',
      '**/{stylelint,eslint}.config.*',
      '**/{oxfmt,oxlint}.config.*',
    ],
  },
});
