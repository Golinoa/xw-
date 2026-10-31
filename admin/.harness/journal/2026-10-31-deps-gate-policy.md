# 2026-10-31 依赖门禁：从「裸退出码」到「够得着 + 有到期日」

## 1. 结论（数字全部取自本次命令输出）

| 指标 | 上一轮（5e169f5 之后） | 本次 |
| --- | --- | --- |
| 全量 advisory | 18（critical 2 → 已清 / high 4 / moderate 10 / low 4 → 记账口径见下） | **18**（critical 0 / high **2** / moderate 12 / low 4） |
| high | 4 | **2** |
| 其中进上线产物的 high | 4 条里 3 条（未分级，按全量算） | **2 条**（@vue/server-renderer、zod），均在白名单内 |
| 开发期工具链 high | — | **0** |
| `quality:dependencies` 退出码 | **1**（永远红） | **0**（首次绿） |

上一轮记的「50 → 18 条 = 4 low / 10 moderate / 4 high」与本次起点一致（本轮开跑前实测同样是 18 条），但**成分不同**：本轮把 4 条 high 里的 2 条真的修掉了，另 2 条走豁免。

## 2. 上一轮记错了一件事：node-forge 不是「上游没有修复版本」

上一轮的结论是「node-forge 的 patched versions 写成 `<0.0.0`，上游根本没有修复版本」。这句话只对**六条 node-forge advisory 里的一条**成立：

- `GHSA-…`（RSA PKCS#1 v1.5 验签接受过期密钥）→ patched `<0.0.0`，确实无修复版；
- 其余五条（PEM 解码 ReDoS、PKCS#12 MAC 伪造、TLS record 两处 DoS、X.509 basicConstraints 绕过）→ **patched `>=1.4.1`**，而树里装的是 **1.4.0**。

也就是说，它们不是「修不了」，是「没装」。一条 `node-forge@>=1.0.0 <1.4.1: 1.4.2` 就清掉（装 1.4.2 而不是 1.4.1，因为 1.4.1 之后还有一条 X.509 绕过）。

同一个错误还漏了 follow-redirects：上一轮的 override 上界是 `<1.16.1`，只挡住「跨 realm sensitiveHeaders 被共用」那一条；`1.16.2` 才修「cross-realm 数组共享」的绕过，实测改上界即清。

**教训与 a-opsfix 那条同源**：把某一支的结论（`<0.0.0`）推广到整个包，读起来像事实，实际是把一个 advisory 的属性当成了包的属性。检查方法很便宜——按 `module_name` 分组看 `patched_versions` 有几组不同的值。

## 3. 口径 2「按生产依赖分级」：`pnpm audit --prod` 不是这个意思

想分级最自然的做法是 `pnpm audit --prod`。实测不行：它仍报 27 条（含 node-forge）。原因不在 pnpm，在 monorepo 的语义——`@vben/vite-config` 把 `nitropack` / `listhen` 写在 `dependencies` 里（它对 vite-config 确实是运行期依赖），于是这些「构建工具链的依赖」在 `--prod` 眼里也是生产依赖。**`--prod` 答的是「非 devDependencies」，不是「进不进上线产物」。**

真正的判据是**上线应用的生产依赖可达集**：

```
pnpm --filter @vben/web-antd list --prod --depth 99 --json   # 0.6s，327 个包
```

本仓只有一个应用会产出上线产物（`build:antd`），所以这个集合是可枚举的。误差方向是**偏保守**（把 workspace 项目当工具用的依赖也算成够得着），宁可多算成「阻断」。

分类结果（实测）：node-forge **不在**该集合（路径是 `@vben/vite-config > nitropack > listhen`），zod / @vue/server-renderer / follow-redirects / qs **在**。

## 4. 口径 3「白名单 + 到期日」：机制写进工具，不写在文档里

`scripts/quality/check-deps-audit.mjs`，四条判定：

1. 够得着的 critical/high 不在白名单 → 红；
2. 白名单条目到期了还在告警 → 红（到期即失效，不是提示续期）；
3. 白名单条目还在、依赖已经不告警 → 红（长期豁免的第一形态就是没人再回看）；
4. moderate / low 只计数，不阻断。

外加两条保命断言：白名单文件缺失 → 红（否则分不清「没漏洞」与「没查」）；生产依赖图为空 → 红（否则一切都算 dev，门禁全绿）。

白名单只收两类（D-11、C-99）：上游确无修复版、路径已论证不可达。当前两条：

- `GHSA-g2v6-rqmx-r4w6` `@vue/server-renderer`：修复要 vue ≥3.5.42，而 3.5.42/3.5.44 改 `defineModel` 重载集合，vben 上游四处泛型 TS2769/TS2322；纯 CSR，产物里 `ssrRenderAttrs` / `@vue/server-renderer` **0 命中**（dist 里唯一一处 `renderToString` 是 echarts 的 `painter.renderToString`）。
- `GHSA-mrhx-c7xc-m3w5` `zod`：修复只在 v4（≥4.6.6），v3 分支没有补丁版；树里 3.25.76（form-ui）与 4.4.3（vsh>knip）都在区间内。升 v4 是独立迁移。

两条到期日都按 D-11 写 **2027-01-28**。

## 5. 变异五枪

| 枪 | 手法 | 结果 |
| --- | --- | --- |
| 1 | 删掉 zod 条目 | 红：`high zod 在生产依赖里且不在白名单`（exit 1） |
| 2 | zod 到期日改 2020-01-01 | 红：`白名单已到期`（exit 1） |
| 3 | 塞一条不存在的 advisory | 红：`白名单条目已失效`（exit 1） |
| 4 | 用「不含 zod 的生产依赖图」喂进去 | 放行，且 zod 被算进 dev——分类轴确实在起作用（也说明图错了就会静默变宽） |
| 5 | 空图 `[]` | **第一次绿了**（exit 0）——守卫只在 `runProdGraph()` 里，`--graph` 入口绕过了它 |

第五枪是这轮唯一一个被自己抓住的漏洞：分类轴的失效方式是「静默变宽」而不是报错，所以断言必须放在两个入口共用的地方。修法：抽出 `loadProdGraph()` 统一守卫，并把「空图必须报错」写进 `--self-test`（现在 11 条断言）。

`--self-test` 还抓到我算错两处预期：条目缺 owner / 到期日格式错，都只产生 1 条错而不是 2 条（advisory 仍按 id 匹配上条目）。预期是猜的，断言是跑出来的。

## 6. 仍未闭环

- **Gitee 网页侧执行记录仍然没有**。本地 `quality:check` 跑通不等于 Gitee Go 跑过，这条从 a0.4 挂到现在，只能在网页上确认。
- 12 条 moderate 里 `qs`（6.15.2 → 6.16.1）、`fast-uri`（3.1.8 → 3.1.9）、`ip-address`（10.7.3 → 10.7.4）都有现成修复版，且 `qs` 在 prod 图里。它们不阻断，但同属「有修复版却没升」，下一轮该清。
- `deepmerge` 的 low 也是 patched `<0.0.0`（与 node-forge 那条同型），low 级，未处理。
- vitest 4.1.7 → 4.1.11 有两组 moderate（mock registry 代码注入 / 任意文件读），属测试期，随下一个 minor 一起升。

## 7. 数字出处

```
pnpm audit --json --registry=https://registry.npmjs.org        → exit 1，18 条
node scripts/quality/check-deps-audit.mjs                      → exit 0，上线产物内 high 2（均白名单）
pnpm --filter @vben/web-antd list --prod --depth 99 --json      → 327 个包
grep -r 'ssrRenderAttrs|@vue/server-renderer' dist/js          → 0 命中
```
