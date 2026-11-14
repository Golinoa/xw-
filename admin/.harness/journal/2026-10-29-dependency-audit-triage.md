# 依赖审计分级评估（阶段 0）

**日期：**2026-10-29
**数据来源：**`pnpm audit --registry=https://registry.npmjs.org --json`（全 lockfile）
**原始统计：**critical 2 / high 20 / moderate 21 / low 7，共 49 条公告，去重后约 20 个模块。

> **方法论声明：**下面的「可达性」是**代码路径分析结论**，不是渗透测试结果。
> 每条都注明了依据；如与实际情况不符，以实测为准。

---

## 一、按可达性分类（决策依据）

### A 类：生产运行时可能暴露（需要处理）

| 模块 | 级别 | 公告 | 生产可达性判断 | 依据 |
| --- | --- | --- | --- | --- |
| `zod` | high | 校验超大输入时耗尽内存 | **理论可达，实际自伤型** | 前端表单校验使用 zod；输入源是运营人员本人，攻击者无法远程构造输入。只有诱导运营人员粘贴超大文本才会触发，影响是其自身浏览器卡顿 |
| `vue-i18n` / `@intlify/core-base` / `@intlify/shared` | high ×3 | `escapeParameter` 未阻止具名变量插值导致的 XSS | **当前不可达** | 本项目所有 `$t()` 调用的键均为静态中文文案，不把用户数据作为插值变量传入。若未来引入「翻译内容含用户输入」的用法则变为可达 |
| `@vue/server-renderer` | high | 属性中缺少 CR 处理导致 XSS | **不可达** | 本项目为纯客户端 SPA，不使用 SSR |

### B 类：仅构建期或开发期（不进生产包）

| 模块 | 级别 | 说明 |
| --- | --- | --- |
| `vite` | high + moderate ×4 + low | dev server 与构建工具。`server.fs.allow` 越界读取、`launch-editor` 参数注入等，仅在本地 `pnpm dev` 时存在；生产构建产物不含 vite 运行时 |
| `tinypool` | **critical ×2** | vitest 的 worker 线程池。原型污染可致 RCE，但只在我们自己编写的测试代码执行时存在，不接收外部输入 |
| `happy-dom` | high ×2 + moderate | 单测的 DOM 环境模拟器，仅 `test:unit` 使用 |
| `vitest` / `@vitest/mocker` | moderate ×3 | 测试框架，任意文件读取类问题需攻击者能控制测试入口 |
| `source-map-js` | high | 构建期 sourcemap 解析 |
| `postcss-selector-parser`、`serialize-javascript`、`fast-uri`、`qs`、`deepmerge`、`ip-address` | moderate / low | 工具链传递依赖 |
| `undici` | high ×8 + moderate ×6 | Node 的 fetch 实现。Safari 目标构建使用浏览器原生 fetch，不打进前端产物；仅在 Node 侧工具使用 |
| `follow-redirects` | high ×2 | Node HTTP 重定向库，浏览器环境不使用 |

### C 类：无修复版本

| 模块 | 级别 | 说明 |
| --- | --- | --- |
| `node-forge` | high | audit 返回 `patched_versions: <0.0.0`，即 **npm 未标记任何修复版本**。前序审计记录称「1.4.2 可清除」，与本次实际输出矛盾——**以本次 audit 为准**，该结论需重新核实 |

---

## 二、结论

1. **没有任何一条 critical/high 处于可被远程攻击者触达的生产路径上。** 2 条 critical 全部落在测试期依赖（`tinypool`），18 条 high 中 15 条属于构建/测试期或浏览器不使用的 Node 库。
2. **真实暴露面只有 `zod` 一条，且是自伤型**（运营人员往自己浏览器里粘贴超大文本），不构成对外风险。
3. 因此「依赖审计挂红」**不应作为阻塞上线的理由，但也不能当作已解决**——它是技术债，不是当前的安全事故。

---

## 三、本轮决策：不升级，只记录

**决策：本阶段不修改任何依赖版本。**

理由：
1. 当前 `pnpm install` 的 `postinstall` 会因沙箱禁用 `wmic.exe` 而失败（tsdown 构建步骤），升级依赖需要重新 install，有破坏当前可用 `node_modules` 与 `dist` 产物的风险；
2. 所有门禁当前全绿（含 171 单测 + 6 个 e2e），在没有充分回归窗口时动 lockfile 属净负收益；
3. 真正的修复需要跨多个主版本（`happy-dom` 20→21、`tinypool` 1→2、`zod`→4.6.6、`vite`→8.3.3），不是一次安全操作。

---

## 四、后续专项建议（按性价比排序）

| 优先级 | 动作 | 风险 | 收益 |
| --- | --- | --- | --- |
| 1 | `vite` 8.3.2 → 8.3.3（patch） | 低 | 清掉 1 high + 4 moderate + 1 low |
| 2 | `source-map-js` → 1.2.2（patch） | 低 | 清掉 1 high |
| 3 | `follow-redirects` → 1.16.1（patch） | 低 | 清掉 2 high |
| 4 | `vue-i18n` / `@intlify/*` → 11.4.14（patch，需确认 Vue 主版本兼容） | 中 | 清掉 3 high |
| 5 | `happy-dom` 20 → 21（major） | 中高 | 清掉 2 high + 1 moderate，需回归全部单测 |
| 6 | `tinypool` 1 → 2（major，随 vitest 升级） | 中高 | 清掉 2 critical |
| 7 | `node-forge` | 未知 | 需先查清是否仍有传递依赖引入；若已无引用应从 lockfile 移除 |

**执行建议：**1–3 可合并为一次低风险 PR；4–6 需单独批次并跑完整回归；7 需先查依赖来源。

---

## 五、给 CI 的结论

`.workflow/frontend-quality.yml` 的 quality 阶段包含 `pnpm run quality:check`，其中 `quality:dependencies` 会在本次审计的高危项上失败。

**该失败是真实的，不是配置问题。** 建议保持现状（不跳过检查），让流水线持续暴露技术债；在完成第四节 1–3 后，audit 统计会明显下降，再评估是否可恢复为全绿门禁。
