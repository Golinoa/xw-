# A1 前端主线 E2E

日期：2026-11-16 · 卡片：P9-A1（P0）· 出口：5 spec / 11 用例，本地 `pnpm e2e` 全绿

## 结果

```
pnpm e2e  →  11 tests in 5 files
  10 passed, 1 skipped（CAPTCHA 用例需 VITE_SUPABASE_CAPTCHA_SITE_KEY）
  用时约 25 秒
```

三个新 spec：

| spec | 覆盖 |
| --- | --- |
| `order-finance-flow.spec.ts` | 计调报款 → 财务一审 → 管理员终审，金额从在途转已收 |
| `order-list-states.spec.ts` | 空列表显示引导而非错误态；500 时给可读错误 + 重试后恢复 |
| `order-permission-guards.spec.ts` | 财务看不到订单写入口但能看到报款/审批；驳回未填意见时提交前拦下 |

外加 `tests/e2e/support/api-stub.ts`：出站响应先过 `@erp/contracts` schema 再返回。

## 那条卡住的断言：根因不是选择器

上一轮判断是「antd 下拉的选项没点中」。**判断错了。**

`auth.spec.ts` 里切换公司的响应体写成：

```js
{ userId, organizationId: 'org-beta', role: 'operator', sessionId }
```

而 `authContextSchema` 还要求 `permissions` 与 `dataScope`。客户端校验响应时直接抛错，
`switchOrganization` 进 catch，`currentOrganization` 从未被赋值 —— 标题当然不变。

报错现场是「点了 Beta Travel，标题没变」，看起来 100% 像交互问题，
实际是桩的响应不合格被契约挡下了。**这正好证明了桩先过契约这条约束的价值**：
它把「桩与契约漂移」变成了可见失败，只是失败长得像另一回事。

修法不是加 `waitFor`，而是让桩用 schema 构造：

```ts
const betaContext = authContextSchema.parse({ ...permissions: [...], dataScope: 'own' });
const fixtureMemberships = meResponseSchema.parse({ userId, memberships });
```

以后桩体再漂移，会炸在 `parse` 这一行，而不是伪装成交互缺陷。

## `npx playwright test` 卡死的真实原因

上一轮记为「worker 不退出，要 `--workers=2`」。**也是误判。**

`npx playwright test` 300 秒零输出 —— 因为 `npx` 在联网找 `playwright` 包，
根本没进到测试执行。走本地 bin 就正常：

```
pnpm e2e
# 或 node node_modules/@playwright/test/cli.js test
```

11 个用例跑完即退出，不需要 `--workers=2`。已把 `e2e` 脚本写进 `udone/package.json`。

## 边界（重要）

这套用例**只证明前端渲染与交互**。桩不模拟 RLS、事务与并发锁，
所以「谁能看到什么」的权限语义、「并发下金额对不对」这类问题不在这里证明 ——
它们由 pgTAP（数据库）与 HTTP 集成测试（PostgREST + 真实 service）负责。

## 踩到的另一个坑

`actionTimeout` 必须显式设置。Playwright 默认动作超时是 **0（无限等）**，
一个有问题的选择器不报错、把用例拖到总超时，只留一句「Test timeout exceeded」，
分不清「元素没出现」还是「点了没反应」。设成 15 秒后，失败信息才有指向。
（这次诊断如果先把 `page.on('console')` 和响应体打出来，能少走一小时弯路。）
