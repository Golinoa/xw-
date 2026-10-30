# Gitee Go 触发器修复与 secret-scan 首红（2026-10-30）

分支 `feat/ops-console`，提交 `620a210`（触发器）、`f895829`（secret-scan）。

## 1. 为什么两条流水线从建立起一次都没跑过

`.workflow/ci.yml` 与 `.workflow/frontend-quality.yml` 的 `triggers.push.branches`
只有 `precise: [main]`，而全部开发都在 `feat/*` 上。**「仓库里有 yml」被当成了
「有 CI」**，因此没有任何人执行过其中任何一步。

修法：改成只用 `prefix` 一个类别写多条（`main` + `feat/`）。这不是风格选择——
Gitee Go 官方文档写明「分支匹配的多种规则是**交集**关系，同时设置只有满足所有
规则才触发」，混用 `precise: main` 与 `prefix: feat/` 会变成「既是 main 又以
feat/ 开头」，等于永远不触发。这个坑写进了两处 yml 注释。

## 2. 触发器修好之后的第一个红，不在原来说的那一步

跑之前 `.workflow/frontend-quality.yml` 顶部写着「已知会红的一步：
`quality:dependencies`」。按 `quality:check` 的 11 步顺序实跑，第一个红是第 8 步：

```
STEP quality:toolchain      exit=0   1s
STEP format:check           exit=0   4s
STEP lint:check             exit=0  16s
STEP check:type             exit=0  19s
STEP test:unit              exit=0  48s
STEP build:antd             exit=0  44s
STEP quality:licenses       exit=0  40s
STEP quality:secret-scan    exit=1   3s   ← 真红在这
```

```
apps/web-antd/src/api/__tests__/env.test.ts
  28:24  error  [BasicAuth] found basic auth credential
  @secretlint/secretlint-rule-preset-recommend > @secretlint/secretlint-rule-basicauth
```

那行是 `assertApiBaseUrl('https://user:pass@ops.example.com/api')`——**待拒绝的
输入**，用例断言它必须抛错。规则判对了（它确实长得像凭据），是夹具需要声明豁免。

**结论比修复本身重要**：yml 里「已知红在某一步」这句话此前从未被验证过，因为
链条在第 8 步就断了，根本走不到第 11 步。这跟「有 yml 就当有 CI」是同一类错误：
**把推测写成了结论**。已在 yml 顶部订正，并把实测的 11 步结果写在原句下面。

## 3. 抑制方式：单行定向，不进 .secretlintignore

```ts
expect(() =>
  // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- 待拒绝的输入
  assertApiBaseUrl('https://user:pass@ops.example.com/api'),
).toThrow(/不得包含用户名或密码/);
```

两个候选方案被否掉：

- **加 `.secretlintignore`**：文件级忽略，会把同文件其余用例的漏检一起吞掉，
  等于用「少扫一个文件」换「这一行变绿」。现在 `.secretlintignore` 里只有
  `.git/`、`node_modules`、`dist`、`coverage`、`.turbo`、`pnpm-lock.yaml`——
  全是产物与锁文件，没有任何源码，不该由这一行开先例。
- **运行时拼字符串绕开扫描**（`'user' + ':' + 'pass'`）：扫描器看不见了，但代码
  变怪，评审者会以为在刻意规避。宁可写一句显式的豁免说明。

踩坑：`secretlint-disable-next-line` 管的是**下一行**，第一次把指令放在
`expect(() =>` 上方，而凭据在再下一行，报错位置从 28 行挪到 32 行照样红
——等于没生效。指令必须紧贴凭据所在行。

## 4. 修复后 11 步全链实跑结果

```
toolchain 0 · format 0 · lint 0 · type 0 · test:unit 0 · build 0 · licenses 0
secret-scan 0 · bundle-secrets 0 · negative 0 · dependencies 1
```

- 单测 53 文件 / 399 用例（第 4 次连跑仍为此数）
- `build:antd` 产物 `dist.zip` 1,554,532 字节，产物内桩夹具关键词 0 命中
- `quality:dependencies`：50 vulnerabilities，7 low / 21 moderate / 20 high / 2 critical

## 5. 留下的两件事（都不掩盖）

1. **Gitee 网页侧未确认**。命令行只能验证「本地等价链」，看不到 Gitee Go 的
   执行记录。需要有人在仓库的流水线页看一眼：`620a210` / `f895829` 两次推送后
   是否真的起了任务。不给结论，只标「未验证」。
2. **依赖债不清，流水线永远红在最后一步**。红一次没人看的流水线等于没有流水线
   ——这正是 a-ci 不能收口的原因。已把 `a-deps` 从「技术债」升级为「CI 唯一剩余
   阻塞」并标 `阻塞CI`。修法上先做 vue-i18n 与 `@intlify/core-base`（同一
   advisory GHSA-83rm-6c8r-g728，`>=11.1.10 <11.4.14`，补到 `11.4.14`），
   这是唯一有理论可达性的一组。

没有为了让流水线变绿而跳过任何一步检查，也没有把 `quality:dependencies` 从
链里摘出去。
