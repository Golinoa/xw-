# 服务端 HTTP 集成：用真实 PostgREST 打通最后一层假设

## 今日完成

用户授权我自行决定 A3 的方案。选 **方案 a**：下载 PostgREST 单文件二进制，连本机已有的原生 PostgreSQL，让服务层真的打一次 HTTP。

新增：

- `scripts/db/local-db.mjs`：`http` 命令（启动 → 重放 → 造夹具 → 起 PostgREST → 跑集成测试 → 全部收尾，一条命令打完）；`ensurePostgrest` / `downloadPostgrest` / `startGateway`；导出常量供测试复用；CLI 分发加了「是否被直接执行」判断，以便被 import 时不触发。
- `tests/integration/harness.ts`：签 HS256 JWT、注入绑定齐的 env、`app.request` 直调。
- `tests/integration/finance-flow.test.ts`：15 条用例走完整条收付款主线。
- `vitest.integration.config.ts`：独立配置；主配置排除 `tests/integration/**`。
- `package.json`：`db:local:http`。

顺带修掉一个真缺陷：`restPage` 把 PostgREST 的 **416** 当错误抛出（见下）。

## 关键决策

- **为什么值得折腾二进制**。方案 b（`pg` 直连）成本低一半，但覆盖不到 PostgREST 自己的行为：416/206、`Content-Range`、SQLSTATE→HTTP 状态码。这次抓到的 bug 恰好全在那一层，等于事后证明方案 b 会漏掉它。
- **只替换 GoTrue，不替换别的**。Supabase Auth 需要整套 OAuth 服务，而它自己的行为已有 `supabase-auth-verifier.test.ts` 覆盖。JWT 仍由 PostgREST 校验，RLS 与 `has_permission()` 全真跑——鉴权以后没有任何桩。
- **加了一个只做前缀重写的网关**。PostgREST 在根路径提供 API，而客户端拼的是 `/rest/v1/...`（生产上由 Supabase 的 Kong 剥掉）。选择在测试基建里补网关，而不是去改仓储层或 rest-client 的路径——为迁就测试环境去改被测代码，验证的意义就没了。
- **集成测试不进 `pnpm test`**。单元测试必须能在没有数据库的机器上通过；两条入口各自独立。

## 遇到的问题

- **`github.com` 在这台机器上连接超时**，只有 `api.github.com` 与 `release-assets.githubusercontent.com` 可达。release 下载页在 github.com 上，直接下必失败；改用 asset API（`Accept: application/octet-stream` 会 302 到 CDN）。15 MB 下了约 20 分钟，中途用 Range 续传。
- **PostgREST 是动态链接 libpq 的**。缺库时进程以 `0xC0000135` 静默退出，没有任何输出，看起来像「二进制坏了」。解决办法是把 PostgreSQL bin 里的 DLL 复制到 exe 同目录——Windows 的 DLL 搜索顺序里 exe 所在目录优先。依赖 PATH 不可靠：脚本可能在 Git Bash 里启动，那里的 PATH 是 POSIX 形式，交给 Windows 加载器会失效。顺带排除了一个假线索：一度以为要补 UCRT（`api-ms-win-crt-*`），实测不需要。
- **`spawnSync` 把网关堵死**。第一版用 `spawnSync` 跑 vitest，网关虽然监听着，但事件循环被同步调用占住，请求全部超时。现象是「测试全部 30s 超时」，很容易误判成 PostgREST 挂了。改成异步 `spawn` + 等 exit。
- **操作员的数据范围是 `own`**。一开始用管理员建单、操作员提交申请，结果申请建完回读 404——操作员看不到管理员名下的订单，连带看不到挂在上面的申请。改成操作员建单，这才是真实的使用路径。
- **`pageSize=1` 不是合法值**，白名单是 10/15/20/30/50/100。分页用例改成「第 2 页 + 每页 10 条」，反而得到了更强的断言：items 为空但 total 仍为 1，正好证明 total 只能来自 `Content-Range`。

## 抓到的缺陷

`restPage` 把 PostgREST 的 **416 Range Not Satisfiable** 当成普通错误抛出，转成 500。

触发条件非常日常：任何列表在筛选后翻到超出范围的页（例如筛选后只剩 1 条，用户点第 2 页）。受影响的是所有列表端点——客户、订单、供应商、应收应付、申请列表。而分页器在总数变化后停留旧页码，是极常见的操作。

修法：`restFetch` 增加 `allowedStatuses` 参数，`restPage` 传 `[416]`，返回空行加 `Content-Range` 里的总数。补了一条单测。

## 变异验证

把服务层 `requested_amount` 改成 `requested_amount_typo`，第 5 条立刻变红（HTTP 500），下游用例连带失败。这正好复现了当初写这条计划时的判断：参数名写错不会有编译错误，只会在运行时变成 500。回滚后连跑两次全绿。

## 规模

- 集成用例 15 条 / 1 个文件；单测 37 文件 256 用例（+1 条 416 回归）。
- 门禁新增 `pnpm db:local:http`，已写进 `ENGINEERING_STANDARDS.md` 与 `TESTING_STANDARDS.md`。

## 遗留

- PostgREST 返回 404（RPC 不存在，例如迁移没应用）时，服务层仍落到 500「服务暂时不可用」，不指向具体原因。变异验证时看到的就是这个形态。属于错误可诊断性，未处理。
- 集成测试依赖本机 Windows 二进制与原生 PostgreSQL；CI 尚未接入（对应计划里的 D2）。其它平台需要自行提供 PostgREST 可执行文件。
- `.vue` 仍然没有类型级检查（对应 A2，未开工）。
