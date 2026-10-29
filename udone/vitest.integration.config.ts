import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * HTTP 集成测试的独立配置。
 *
 * 这些用例要求真实的 PostgreSQL + PostgREST，由 `pnpm db:local:http` 启动后再跑，
 * 因此不能进 `pnpm test`：单元测试必须能在没有数据库的机器上通过。
 * 主配置已经把 `tests/integration/**` 排除，两边各有各的入口。
 */
export default defineConfig({
  resolve: {
    alias: {
      // tests/ 不是 workspace 包，解析不到 @erp/contracts 的包名，
      // 而 apps/ 下的代码也依赖同一个包名，所以在这里统一指到源码入口。
      '@erp/contracts': fileURLToPath(
        new URL('./packages/contracts/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    // 真实 HTTP + 真实事务函数，比打桩的用例慢一个数量级。
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 共用一个数据库，并行只会让断言互相踩。
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
