# 2026-10-30 · 配置面收口（环境变量与密钥）

## 本轮做了什么

起点是一次配置面审计：把 `udone/.env.example`、`udone/wrangler.toml`、`.workflow/*` 三处
摊开，逐键核对「谁提供、缺失时会发生什么」。审计查出三处缺口，全部收口。

| 缺口 | 改法 | 提交 |
|---|---|---|
| `SUPABASE_JWT_SECRET` 不在 `check:deploy` 清单，删掉它门禁仍全绿 | 纳入 `WORKER_ENV_VARIABLES` / `ENV_EXAMPLE_VARIABLES` / `BLANK_IN_EXAMPLE`，并在 `env.d.ts` 声明 | `aacab80` |
| 没有本地模板，`wrangler dev` 只读 `.dev.vars` | 新增 `.dev.vars.example` + 键集合一致性检查 | `aacab80` |
| 发布文档没有任何一处列出部署前必须注入的密钥 | `Docs/RELEASING.md` §8 | `567510f` |

## 三处判断

1. **`SUPABASE_JWT_SECRET` 必须是可选类型，但必须进清单。** 可选的理由：本地与 CI
   没有 GoTrue，服务要能起来。进清单的理由：缺它不报错，只是幂等命名空间退化为
   令牌哈希——access token 一刷新，同一笔重复提交就落两行。这类降级在部署日志里
   和「配好了」长得完全一样，运行期没有任何信号，只能靠名字门禁拦。

2. **门禁自身也有洞，是变异打出来的。** 第一版 `WORKER_ENV_VARIABLES` 用
   `workerEnv.includes(name)` 判定。删掉 `env.d.ts` 里 `SUPABASE_JWT_SECRET?: string;`
   整行，门禁仍然绿——因为上面那句注释「不能拿 SUPABASE_JWT_SECRET 是否存在当开关」
   里就有这个名字。注释提到一个名字，和类型面声明它、让 `context.env.X` 能通过编译，
   是两件事。改成匹配 `^\s*NAME\??:\s*string;` 的声明行后变异转红。

3. **模板双源要有机械约束，否则一定漂移。** `.env.example`（文档）与
   `.dev.vars.example`（本地填法）分属两种用途，很难合并成一份；但只要没有检查，
   新加的服务端变量就只会出现在其中一处。所以把「两份键集合相等」写进 `check:deploy`：
   漏键与多键都报，且报错指名具体键。

## 变异四枪，全红

| 变异 | 期望报错 | 实测 |
|---|---|---|
| 删 `.env.example` 的 `SUPABASE_JWT_SECRET=` | `.env.example is missing SUPABASE_JWT_SECRET` | 红（连带报模板多出该键） |
| 删 `env.d.ts` 的声明行 | `Worker environment types are missing SUPABASE_JWT_SECRET` | 红（修改判定后才红，见判断 2） |
| `.dev.vars.example` 少一键 | `.dev.vars.example is missing SMOKE_USER_PASSWORD` | 红 |
| 删整份 `.dev.vars.example` | `Local template .dev.vars.example is missing` | 红 |

复原后 `check:deploy` 绿。
注：变异 2 第一枪是绿的，是它暴露了 `includes` 判定的问题，不是断言写松。

## 门禁实测

```
format ✓   lint + css tokens ✓   typecheck(含 .vue) ✓   test 43 文件 316 用例 ✓
build ✓（主 chunk 1,638.08 kB，与上轮同值）   check:deploy ✓   board:check ✓
```

`db:local:verify` / `db:local:http` 本轮未跑：改动不触 SQL、不触 RPC，两条链路的
输入没变；上次实测为 12 文件 223 断言、5 文件 33 条。

## 悬着的一件

运营端副本 `ERP-ops/udone/.env.example` 只有 16 键，缺 `SUPABASE_JWT_SECRET` 与
`ALLOW_LOCAL_JWT_AUTH`（该副本 HEAD `9a8ebc5` 早于 `dd4e254`）。已登 `C-96`，
补完在运营端跑一次 `pnpm check:deploy` 才能算闭环。

## 下一步

`U05` 登录代理仍是 M1 最后一块：`/auth/login`、`/auth/refresh`、`/auth/logout`。
本地没有 GoTrue，验收必须拆成「上游替身 + 成员判定走真实 RLS」两段，journal 里要
写明哪一段是替身。
