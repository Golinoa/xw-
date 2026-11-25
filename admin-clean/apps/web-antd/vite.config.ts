import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from '@vben/vite-config';

/**
 * 契约包 `@erp/contracts` 是纯 TS 源码 workspace 包（exports 指向 src/index.ts），
 * 不发布到 registry。用别名直连 udone 源码，避免复制一份导致契约漂移。
 */
const contractsEntry = fileURLToPath(
  new URL('../../../udone/packages/contracts/src/index.ts', import.meta.url),
);

export default defineConfig(async () => {
  return {
    application: {},
    vite: {
      resolve: {
        alias: {
          '@erp/contracts': contractsEntry,
        },
      },
      /**
       * contracts 用 zod 4 的顶层 API（z.email / z.uuid / z.iso），
       * 而本仓顶层是 Vben 用的 zod 3。预构建会按项目根解析成 zod 3，
       * 导致 dev 下报 `z.email is not a function`，故排除它按源码路径各自解析。
       */
      optimizeDeps: {
        exclude: ['zod'],
      },
      server: {
        proxy: {
          '/api': {
            changeOrigin: true,
            rewrite: (path) => path.replace(/^\/api/, ''),
            // mock代理目标地址
            target: 'http://localhost:5320/api',
            ws: true,
          },
        },
      },
    },
  };
});
