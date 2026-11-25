# 2026-10-30 后端 P0 回执处理 + 一个必须承认的配置错误

## 0. 一句话

对方 §11 列了 4 条 P0、3 条 P1，其中 3 条在我这侧。本轮完成 P0-1（入库推送）与
P0-3（契约版本门），P0-2 补齐契约 §5.1 的认证三端点。过程中发现**我前两轮关于
vitest `maxForks` 的「修复」从未生效**——那份配置从来没被加载过。

## 1. P0-1 入库并推送（已完成）

`feat/ops-console` 已推到 `origin`（gitee），4 个提交，工作树从 90 项脏变干净：

| 提交 | 内容 |
| --- | --- |
| `4551893` | `chore(tooling)` eslint/oxfmt 规则互斥、vitest 并发 |
| `f774ffd` | `docs(ops)` 契约、交接书、journal |
| `54b5a09` | `feat(ops-console)` 8 域客户端与页面（264 文件） |
| `2052c8a` | `docs(ops)` DESIGN.md 表格分隔符 |

拆 4 个而非 1 个，是为了让「配置改动」和「业务代码」可分别回滚。

## 2. P0-3 契约版本门（已完成）

### 现状是「注释在做假承诺」

`session.ts` 的 `fetchOpsMeta` 注释写「前端据 contractVersion 做不兼容快速失败」，
但全仓**无任何比较代码**，`api/ops/README.md` 又自承「暂不阻断」。契约 §2.1、§8
两处都把它写成已验证的拦截。三处文件三种说法，代码只实现了最弱的那一种。

### 判定规则（已写进契约 §2.1.1）

版本形态 `MAJOR.MINOR[.PATCH][-prerelease][+build]`：

- **MAJOR 不等 → 阻断**（破坏性变更，前端字段对不上时症状是「莫名 undefined」，比报错难查）
- **MINOR/PATCH 不等 → 放行**（契约按加法演进）
- **解析失败 → 阻断**（返回 `''`/`null` 的半成品 `/meta` 不能当兼容，否则是静默降级）

落点：`api/ops/identity/contract-version.ts`（纯函数）、`store/auth.ts::readContractVerdict`
（调用点）。**放在登录成功之后**而非登录前——否则运维连升级提示都看不到，只能看白屏。

### 遇到的一个真实冲突

桩的版本是 `1.0.0-stub`（用后缀标明「不是真后端」，这是诚实隔离的一部分）。
我最初的正则拒绝后缀，于是桩会被判 `MALFORMED`，**整条 e2e 会被自己的门禁挡在登录页外**。

正确修法是放宽解析而不是改桩：semver 本来就允许预发布后缀，MAJOR 判定与后缀无关；
否则将来后端返回 `1.1.0-rc1` 也会把整站断掉。已加用例把「桩版本」与「门禁」钉在一起，
谁改桩版本号立刻有反馈。

## 3. 必须承认的错误：vitest 配置从未生效

### 症状

单测出现「所有用例通过但 exit 1」，`Errors 1 error`，`Failed to start forks worker`
+ `Timeout waiting for worker to respond`。**被跳过的整个测试文件不会出现在失败列表里**，
只是总数变少（曾静默漏掉 `command-submission.test.ts` 的 7 个用例）。

### 我之前的两个结论都是错的

1. 第一次归因 `stub-contract.test.ts` 的 `resetModules`，改成单次导入 → 换文件复现。
2. 第二次归因 fork 并发过高，在 `admin/vitest.config.ts` 设 `maxForks: 4` → 仍然复现。

### 真因

**`admin/vitest.config.ts` 从未被加载过。** vitest 查配置是从 cwd 逐级向上，先命中
`vite.config.*` 就停；`apps/web-antd` 下有 `vite.config.ts`，所以从该包目录执行的
`vitest run` 永远读不到上层那份文件。

实测确认（不是推理）：把 `admin/vitest.config.ts` 的 `environment` 改成
`'this-env-does-not-exist'`，测试**照样通过**。而 `happy-dom` 实际来自 CLI 的 `--dom`。

同时发现第二个问题：**vitest 4 已移除 `poolOptions`**，写入会被静默忽略并打印
DEPRECATED。并发上限改用顶层 `maxWorkers`。

### 修法

新建 `apps/web-antd/vitest.config.ts`（vitest 会优先取它），并 `mergeConfig` 继承
`./vite.config` 的解析结果——否则会丢掉 Vue 插件与 `#/` 别名，`.vue` 用例立刻崩。
`exclude` 必须基于 `configDefaults.exclude` 追加，直接写数组是覆盖默认规则。

`admin/vitest.config.ts` 已删除（从未生效，留着只会让下一个人继续改错地方）。

### 结果

| | 之前（forks，默认配置） | 现在（threads，maxWorkers=4） |
| --- | --- | --- |
| 文件 | 47（静默漏 1 个） | 48 |
| 用例 | 337 | 347 |
| 退出码 | 1 | 0（连跑两轮一致） |
| 耗时 | 83.5s | 27s |

## 4. P0-2 契约 §5.1 补认证三端点（已完成）

三端点只写在 handoff §5.1 的「缺口」表里，契约正文 0 处提及。已并入契约 §5.1
正式端点表，并补了两条容易踩的约定：认证端点豁免 `Authorization`；`SameSite=Strict`
只在同源成立，跨源必须 `None; Secure` 且开 CORS 凭证，否则「登录成功但立刻 401」。

## 5. 未做 / 待对方

- **P0-4 identity 幂等键**：需要先有 `/operators`、`/roles`、`/audit-events` 客户端
  （当前 identity 只有 `session.ts`）。属 Task 8 治理域，不阻塞 T-03。
- **P1-1** §9 口径改「8 个业务域 + identity 仅会话层」：已在 handoff 回执段说明，
  正文数字等 Task 8 完成后再统一改，避免改两次。
- **P1-3** e2e 专用 env：`apps/web-antd/.env.e2e` 已存在且 `VITE_OPS_MOCK=true`，
  对方这条建议**已经落地**，不需要再改。

## 6. 门禁（本机实测，连跑两轮同结果）

typecheck 0 错 ｜ 单测 48 文件 347 用例 exit 0 ｜ lint 0 警告 0 错误 ｜
format 全匹配 ｜ e2e 6 例通过。

## 7. 教训

**「复跑变绿」不是证据。** 这两轮的真正教训不是并发数，而是：改了一个文件就以为
改对了。验证配置是否生效，要看「改坏它是否报错」，而不是「改好它之后是否通过」。
