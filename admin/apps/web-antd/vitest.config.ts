import { configDefaults, defineConfig, mergeConfig } from 'vitest/config';

import appConfig from './vite.config';

/**
 * 单测配置。
 *
 * ## 为什么放在这里而不是 `admin/vitest.config.ts`
 *
 * vitest 查找配置的顺序是「当前目录 → 逐级向上」，并且**先命中 `vite.config.*`
 * 就停下**。`apps/web-antd` 下有 `vite.config.ts`，所以从本包目录执行的
 * `vitest run` 永远读不到 `admin/vitest.config.ts`——那份文件写了很久但从未生效
 * （实测：把它里面的 `environment` 改成不存在的值，测试照样通过）。
 *
 * ## 为什么要继承 `./vite.config`
 *
 * `vite.config.ts` 走的是 `@vben/vite-config` 的封装，Vue 插件、`#/` 别名、
 * TS 路径解析都在里面。分离出 test 配置后若不自带这些插件，`.vue` 用例会立刻
 * 报「Failed to parse source」。
 */
export default defineConfig(async (env) => {
  const resolved =
    typeof appConfig === 'function' ? await appConfig(env) : appConfig;

  return mergeConfig(resolved as Record<string, unknown>, {
    test: {
      // 47 个测试文件各自要解析一遍 vue/antd/vben 的模块图（import 累计 90s+）。
      // fork 池每个 worker 都是新的 node 进程，冷启动 + 冷模块图在磁盘争用下会
      // 超过 vitest 内置的 worker 响应超时，症状是「用例全过但 exit 1 +
      // Timeout waiting for worker to respond」，且被跳过的整个测试文件不会
      // 出现在失败列表里（曾静默漏跑 command-submission.test.ts 的 7 个用例）。
      //
      // threads 池复用进程内存，启动开销显著更低；并发限制为 4，避免
      // 16 核机器默认起 15 个 worker 把 IO 打满。
      // vitest 4 已移除 `poolOptions`（升级时会打印 DEPRECATED），并发上限
      // 改由顶层 `maxWorkers` 控制；写成 poolOptions 会被静默忽略。
      pool: 'threads',
      maxWorkers: 4,
      environment: 'happy-dom',
      environmentOptions: {
        happyDOM: {
          settings: {
            // happy-dom v20+ 默认禁用 JS 求值（安全修复），这里按成功处理以保持
            // 既有测试行为。
            handleDisabledFileLoadingAsSuccess: true,
          },
        },
      },
      // 必须基于 configDefaults 追加：直接写数组是**覆盖**默认排除项，
      // 会漏掉 node_modules/dist/vite.config 等默认规则。
      exclude: [
        ...configDefaults.exclude,
        '**/e2e/**',
        '**/{stylelint,eslint}.config.*',
        '**/{oxfmt,oxlint}.config.*',
      ],
    },
  });
});
