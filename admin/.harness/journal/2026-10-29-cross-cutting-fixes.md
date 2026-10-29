# 横切修复：桩泄漏 / 测试假失败 / 工具链互斥

- 日期：2026-10-29
- 范围：`admin/**`（不涉及后端）
- 触发：Task 6/7 交付后的一致性复核
- 性质：三个问题**都不是新功能**，而是「门禁全绿但事实不对」的缺陷

## 1. 开发态桩被打进生产包（真实泄漏）

**症状**：生产包 `dist/js/` 下存在 5 个 `dev-stub-*.js` 分块，含虚构客户名、`example.invalid` 邮箱等夹具数据。

**根因**：桩开关被封装成函数：
```ts
export function isSupportStubEnabled(): boolean {
  return import.meta.env.VITE_OPS_MOCK === 'true';
}
// 调用点
if (isSupportStubEnabled()) { const { stubX } = await import('./dev-stub'); ... }
```
`import.meta.env.VITE_OPS_MOCK` 在构建期被替换为字面量 `"false"`，但**跨模块函数调用的返回值不会被常量折叠**，`if (函数调用())` 无法判定为永假，动态 `import()` 因而保留，分块被打包。

对照：`customer`/`contract`/`catalog` 三域用的是**调用点内联**写法 `if (import.meta.env.VITE_OPS_MOCK === 'true')`，同一次构建中它们的桩分块为 0 —— 这就是 A/B 证据。

**修复**：5 个域（billing / entitlement / tenant / deployment / support）共 **60 处调用点**改为内联字面量比较；删除 5 个 `endpoints.ts` 中的开关函数（共 14 个 import 随之移除）。

**验证**：
| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| `dist/js/dev-stub-*.js` | 5 个 | **0 个** |
| 含 `example.invalid` 的文件 | 1 | **0** |
| 含「（虚构）」的文件 | 5 | **0** |
| dist.zip | 1,543,683 B | **1,513,696 B**（−30 KB） |

残留 1 处「示例旅行社甲」经查证是**表单元数据占位提示**（`placeholder: 例如：示例旅行社甲`），属正常 UI 文案，非夹具数据。

**教训**：桩开关必须是**调用点可见的字面量比较**。以后新增域时，这条要作为评审检查项，光靠「文档里写了要 tree-shake」不成立。

## 2. 单测「全部通过但进程非零退出」（假失败）

**症状**：多次出现 `Test Files 46 passed / Tests 315 passed` 但 exit 1，且用例数在 46~47 间跳动；CI 上会误判为失败。

**根因**（抓完整日志才看到）：
```
Unhandled Error
Error: [vitest-pool]: Failed to start forks worker for test files
  .../src/api/__tests__/stub-contract.test.ts
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
```
`stub-contract.test.ts` 每个用例都执行 `vi.resetModules()` + 动态 `import()`，反复重建整张依赖图（含请求客户端与权限目录），fork worker 启动/响应超时。此前我把它当成「5s 断言超时」放宽到 20s，**掩盖了真因**——超时不在断言，在 worker。

**修复**：改为 `beforeAll` 中**一次**动态导入 + 取消 `vi.resetModules()`，并撤销 20s 局部放宽（恢复全局快速失败）。依据：桩开关已改为调用点读取 `import.meta.env`，运行时改环境变量即生效，无需重建模块图。

**验证**：连续两轮 `test:unit` 均 `47 files / 321 tests`、**exit 0**；此前 3 次运行均为假失败或计数抖动。

## 3. ESLint 与 oxfmt 互相覆盖（门禁不可能同时绿）

**症状**：`lint:check` 报 9 处错误，全在既有文件；而 `eslint --fix` 修完再跑 `format:check` 又变红。

**根因（实测往返，非推测）**：
| 规则 | 规则要的 | oxfmt 产出的 | 结论 |
| --- | --- | --- | --- |
| `vue/html-closing-bracket-newline` | 多行标签 `>` 不换行 | 折行时 `>` 断到下一行 | 互相覆盖 |
| `unicorn/number-literal-case` | 十六进制数字位大写 `0x0F` | 统一转小写 `0x0f` | 互相覆盖 |

第一条规则的判定逻辑是「最后一个属性与标签起始同行 → 视为单行 → 要求不换行」（读了 `eslint-plugin-vue@10.9.1` 规则源码确认），而 oxfmt 只要标签折行就断 `>`。**调选项无法对齐**——`multiline: 'always'` 也不行（实测仍报错）。

**修复**：在 `internal/lint-configs/eslint-config/src/configs/` 中关闭这两条规则，并写明理由：**格式的唯一裁决者是 oxfmt（`format:check`），ESLint 不再裁决空白与字面量大小写**。改的是配置源码，需重建 `dist` 才生效（`pnpm --filter @vben/eslint-config run stub`）。

**验证**：对 4 个涉事文件做「`eslint --fix` → 比对 md5 → `oxfmt --check`」往返，**哈希完全一致且格式通过**，证明不再 ping-pong。`lint:check` 273 文件 0 错。

## 4. 附带修正

- `api/adapter/request-id.ts`：`0x0f/0x3f` 大小写引发上述冲突，随规则关闭而稳定。
- `api/ops/billing/dev-stub.ts`：嵌套三元改为 `Map` 查表（可读性 + 消除 `no-nested-ternary`）。
- `api/__tests__/stub-contract.test.ts`：重写加载方式（见 §2）。

## 5. 门禁终态（本机实测）

| 门禁 | 结果 |
| --- | --- |
| `typecheck` | 0 错误 |
| `test:unit` | 47 文件 / 321 用例，exit 0（连跑两轮一致） |
| `lint:check` | oxlint 273 文件 0/0；eslint、stylelint 静默通过 |
| `format:check` | All matched |
| `build:antd` | 11 tasks 成功，桩分块 0 |
| `playwright test` | 6 例通过（真实 chromium） |

## 6. 遗留

- 单测仍存在「并发下的计数抖动」历史记录，但假失败根因已消除；若再现需按同样方法抓 `Unhandled Errors` 段，不要只放宽超时。
- 两条 ESLint 规则是**关闭**而非修好上游：若将来换回 prettier 生态，需要重新评估。
