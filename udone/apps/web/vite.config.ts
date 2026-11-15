import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

// 第三方依赖按生态切成独立 chunk：应用代码改动不会让浏览器的 vendor 缓存失效。
// 不能用「一个 vendor 一把切」——会把 1.4 MB 的 antd 与业务代码的正向收益互相抵消。
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  if (id.includes('/@vue/') || id.includes('/vue/') || id.includes('/vue-router/'))
    return 'vendor-vue';
  if (id.includes('/ant-design-vue/') || id.includes('/@ant-design/')) return 'vendor-antd';
  if (id.includes('/@supabase/')) return 'vendor-supabase';
  return 'vendor';
}

export default defineConfig({
  plugins: [vue()],
  build: {
    rollupOptions: {
      output: { manualChunks },
    },
  },
});
