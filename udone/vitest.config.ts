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
    exclude: ['**/.worktrees/**', '**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
});
