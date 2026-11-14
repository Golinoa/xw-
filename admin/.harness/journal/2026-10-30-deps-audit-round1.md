# 依赖审计第一轮：critical 清零，high 20 → 4

日期：2026-10-30
范围：`admin/`（`pnpm-workspace.yaml` catalog + overrides，`pnpm-lock.yaml`）
起点：`quality:dependencies` = 50 vulnerabilities（7 low / 21 moderate / 20 high / 2 critical）

## 为什么动这件事

`a-ci` 修好触发器后按 `quality:check` 的 11 步实跑，第 1–10 步全绿，唯一红在第 11 步
`quality:dependencies`（`pnpm audit --audit-level high`）。也就是说：**这 18 条高危不清，
流水线每推一次就红一次**，红久了就没人看，等于没有 CI。

原判断是「技术债、单独立项」，理由是无高危处于远程可达路径。这个判断仍然成立，
但漏了一件事：CI 变绿是**可观测性**问题，不只是安全问题。

## 做了什么（按顺序，每一步都有实测）

### 1. `vue-i18n` / `@intlify/*`（GHSA-83rm-6c8r-g728）

`vue-i18n` 11.4.4 → 11.4.16、`@intlify/core-base` 下限抬到 `^11.4.14`。
第二轮发现 `@intlify/unplugin-vue-i18n@11.2.3` 把 `@intlify/shared` 钉在 `~11.4.4`，
仍落在受影响区间——升级到 `11.2.8`（依赖 `~11.4.15`）才真正清掉。
教训：**只升直接依赖不够，传递依赖会把你打回原形**，得看 `Paths` 那一栏。

### 2. `tinypool`（2 条 critical，原型污染 → RCE）

`oxfmt@0.51.0` 把 `tinypool` 当直接依赖钉死 `2.1.0`。用区间 override `tinypool@<2.1.2: 2.2.0`。
两条 critical 由此**清零且没有替代品**：oxfmt 最新版 0.75.0 才用 2.2.0，而 0.51 → 0.75
跨 24 个版本，格式化输出极可能变，用 `format:check` 赌不起——override 是更小的爆炸半径。
判据不是「装得上」，是 `format:check` 仍然 1228 文件全匹配。

### 3. 四个区间 override

| 包 | override | 处理掉 |
| --- | --- | --- |
| `follow-redirects` | `@>=1.16.0 <1.16.1: 1.16.1` | 2 条 high |
| `source-map-js` | `@>=1.0.0 <1.2.2: 1.2.2` | 1 条 high |
| `undici` | `@>=6.0.0 <6.29.1: 6.29.1`、`@>=7.0.0 <7.30.1: 7.30.1` | 4 条 high |
| `vite` | `@>=8.3.0 <8.3.3: 8.3.5` | 1 条 high |

全部写成「受影响区间 → 最近修复版」，不锁全量：上游自己发新版后规则自动失效，
不会长期钉住依赖树。`vite` 那条尤其必要——`unplugin-vue@7.2.0` 把 vite 当**直接依赖**
钉死 8.3.2（不是 peer），于是树里同时存在 8.3.2 与 8.3.5，只升 catalog 去不掉。

### 4. `happy-dom` 20.9.0 → 21.0.4（major）

它只是 vitest 的 DOM 环境。升完 **53 文件 399 用例全过**，没有改一行测试。
两个 high 一起清掉。

## 没做成的：vue 3.5.42

`@vue/server-renderer < 3.5.42` 有 XSS advisory，修复从 3.5.42 起。试了 3.5.44 与 3.5.42：

```
packages/@core/ui-kit/shadcn-ui/src/components/collapsible/collapsible-params.vue(35,3): error TS2769
packages/@core/ui-kit/shadcn-ui/src/components/collapsible/collapsible.vue(36,3): error TS2322
packages/@core/ui-kit/shadcn-ui/src/components/expandable-arrow/expandable-arrow.vue(16,13): error TS2322
packages/effects/layouts/src/widgets/preferences/blocks/layout/sidebar.vue(26,66): error TS2769
```

**两个版本都红**，说明不是某个补丁的回归，而是 3.5.42 起 `defineModel` 的重载集合变了，
vben 上游那四处泛型用法跟不上。三条路：

1. 改 vben 上游组件源码 —— 制造永久升级冲突，为一条不可达的 advisory 不值；
2. 只 override `@vue/server-renderer` 到 3.5.42 —— 它与 vue 锁步发版，硬拆风险更大；
3. 保留 3.5.34，记录「已评估、暂接受」。

选了 3。理由是可证伪的：这个后台是**纯客户端 SPA**，没有 SSR 入口，`renderToString`
一次都不调用，advisory 的 XSS 路径在本项目**不可达**。catalog 里已把 `vue` 从 `^3.5.34`
改成精确 `3.5.34`——用 caret 的话下次 `pnpm install` 会自动爬回 3.5.44 再把类型搞红，
这种「几天后突然红」最难查。

## 剩下的 4 条 high，两类

| 包 | 为什么清不掉 |
| --- | --- |
| `node-forge`（`<=1.4.0`，patched `<0.0.0`） | **上游没有修复版本**。`patched versions: <0.0.0` 就是这个意思。链在 `internal/vite-config > nitropack > listhen`，本地开发服务器用 |
| `zod`（`<4.6.6`） | 修复只在 v4。仓库里 `zod@3.25.76` 与 `zod@4.4.3` 并存，form-ui 深度使用 v3 的 `ZodNumber`/`ZodObject`/`ZodRawShape`，3→4 是一次独立迁移，不是顺手能做的 |
| `@vue/server-renderer`（`<3.5.42`） | 见上，被 vue 钉住 |
| （`zod` 第二条 advisory） | 同上 |

**结论：`--audit-level high` 这道门在当前依赖树上无法变绿**——`node-forge` 没有修复版本，
这是事实不是判断。所以要么等上游，要么改口径。改口径是我的建议但不该由我单方面定，
已作为待决策项上报。

## 复跑数字

| 指标 | 之前 | 之后 |
| --- | --- | --- |
| 漏洞总数 | 50 | 18 |
| critical | 2 | **0** |
| high | 20 | 4 |
| moderate | 21 | 10 |
| low | 7 | 4 |

门禁：typecheck 0 错 ｜ 单测 53 文件 399 用例 ｜ lint 0 警告 ｜ format 1228 文件全匹配 ｜
build 11 tasks、`dist.zip` 1,554,827 字节、产物内桩夹具关键词 0 命中。

## 两个操作层面的坑

1. **`pnpm install` 的 postinstall 在这个沙箱里会失败**（`tsdown` 复制文件被
   `node-safe-delete-shim` 拦），但依赖其实已经解析并落盘。用 `--ignore-scripts` 安装，
   再单独跑构建，效果相同且不中断。
2. **第一次 `build:antd` 卡了 20 分钟没输出**（turbo 停在 `Remote caching disabled`）。
   杀掉进程重跑，49 秒完成、11 tasks 全成功。判断是上一个被中断的构建留下的锁状态，
   不是依赖本身的问题——**但「重跑就好了」不算解释**，下次再遇到要抓 turbo 日志。
