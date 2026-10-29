# 收付款申请：契约、端点、界面与付款断言

## 今日完成

上一轮只做到数据层（四个函数 + 19 条断言），经纪人无处发起、财务无处审批。这一轮按契约 → API → 前端 → 付款断言四步补完，每步单独提交、门禁通过后才提交。

- `packages/contracts/src/finance-applications.ts`：kind / status / method / action 四个枚举，创建、审批、撤回三类请求 schema，列表查询、明细项、详情（含轨迹）响应 schema。新增三个错误码 `FINANCE_AMOUNT_EXCEEDS_AVAILABLE`、`FINANCE_APPLICATION_STATE_CONFLICT`、`FINANCE_SELF_APPROVAL_FORBIDDEN`。
- `apps/api/src/modules/finance-applications/`：仓库层（RPC + 订单/客户/明细装饰 + 关键词三段匹配）与六个端点（列表、创建、详情、审批、撤回、撤销终审）；`FINANCE_APPLICATION_REPOSITORY` 注入点。
- `apps/web/src/views/finance/`：`FinanceApplicationListView.vue`（默认待审、状态/类型/关键词筛选、URL 即状态）、`FinanceApplicationFormModal.vue`（挂在订单金额行上发起）、`finance-application-display.ts`（文案映射 + 三个按钮可见性纯函数）。
- `supabase/tests/finance_payment_application.sql`：28 条断言覆盖付款路径，全部用命名参数调用。

规模：13 个迁移、11 个 pgTAP 文件 189 条断言、37 个单测文件 255 个用例、31 个端点。

## 关键决策

- **契约先行，但端点注册与 API 同批落地**。`route-parity` 双向对账要求清单与真实路由同时存在，上一次提交只写 schema 不注册 `ROUTES`，就是为了不制造一批指向 404 的清单条目。
- **权限按动作分到路由上，不写进 handler**。列表/详情用 `order.read`（与应收应付同口径：能看订单就该看到它的申请），创建/撤回用 `finance.write`，审批/撤销用 `finance.approve`。「谁能做什么」由中间件表达，而「这笔申请能不能被他处理」由库函数表达（创建人、管理员），两层各管一种边界。
- **两个 409 给不同错误码**。`VERSION_CONFLICT`（别人刚审过，刷新重试）与 `APPLICATION_STATE_CONFLICT`（状态已变）都是 409，但界面需要说清是哪种。错误码的分界不是「严重程度」，是「重试有没有用」。
- **库函数的 42501 必须接住**。财务角色点终审时数据库拒绝，PostgREST 翻成 403，不接就是 500「服务暂时不可用」——用户只是没这个权限，不是服务器坏了。这一层用 `FinanceApplicationForbiddenError` 转成 403 FORBIDDEN。
- **界面不显示提交人姓名**。`profiles` 只有 `profiles_select_self` 一条读策略，服务端拿用户令牌读不到同事姓名。只区分「你 / 其他成员」，比编一个名字好。要显示姓名得先决定「同租户是否互看姓名」，那是权限设计问题。
- **发起入口放在金额行上**。申请本来就挂在某一行，让用户先选订单再选行，等于多给一次选错行的机会。上限取该行可申请余额，但只做提交前提示——真正的判定是库里的 `FOR UPDATE` 行锁，两个人同时申请时前端手里的上限一定是旧值。
- **付款断言用命名参数调用**。API 通过 PostgREST 的 JSON key 匹配参数名，改名不会有编译错误、只会在线上 500。命名参数调用把「参数名」也变成被断言的东西。

## 遇到的问题

- 服务层对 RPC 的假设没有任何门禁能覆盖：单测里的仓库是打桩的，参数名或返回列名猜错只会在生产 500。用一个临时 SQL 探针（真实 PostgreSQL，跑完 `ROLLBACK`）验证了 9 个参数名、`result_application_id` / `new_status` / `new_step` / `error_code` 四组列名、业务失败走返回值而非异常、待审只占 `pending`、终审才转 `confirmed`、付款路径与收款对称。探针不入库，价值已经在断言里。
- 探针第一次跑失败在编码上：`psql -c` 走 Windows 控制台代码页，SQL 里的中文注释被判成 `invalid byte sequence for encoding "UTF8"`。改成纯 ASCII 才跑通。`psql -c` 同样不支持 `\echo` 与 `\gset`（那是交互式/文件模式的元命令），所以取值改用 `set_config` + `current_setting`。
- **vitest 偶发 worker 超时**：三次（34 文件 214 用例 + 1 error、34 文件 233 用例 + 2 error、本次首跑）。复跑均干净，今天仍是 37 文件 255 用例全过。所有现象都发生在刚跑完数据库重放或其它重任务之后，怀疑是 CPU 争用导致 worker 握超时，**依然没有证据**，config 未改。这已经是第三次，下次复现要留下当时的进程列表。
- 付款断言里「跨租户不可寻址」最初用操作员身份测，会先被 `finance.approve is required` 挡下——断言虽然也失败，但失败原因是权限而不是租户隔离，等于什么都没证明。改成管理员身份后才真正测到租户边界。

## 已知未解

- **界面没有在浏览器里跑过**。本地没有可用的 Supabase 栈，Playwright 三个 spec 仍未执行、未接入 CI。当前只到「编译通过 + 纯函数有断言」，布局与交互仍需真机验证。这是本轮最大的未验证面。
- **明细行删除会带走申请**。`finance_applications` 的外键是 `ON DELETE CASCADE`，某一行被删掉时挂在上面的申请一起消失。已被驳回或已撤回的申请不占额度，行就变成可删状态，于是审批历史跟着没了。要修得把外键改成 `RESTRICT` 或改成软删，两者都牵动订单编辑流程，没有在这一轮硬塞。
- `R-APPROVAL-01` 流程配置化仍未做：两级审批写死，「允许同人审批」固定否。契约里的 `FINANCE_APPLICATION_FINAL_STEP` 与库里的 `current_step CHECK` 是两处硬编码，配置表落地时要一起改。
- 站内通知（`R-NOTIFY-01`）未接：审批有结果时没有任何提示，只能靠人自己刷新待审列表。
- `index-*.js` 打包 1,638.00 kB（gzip 506.52 kB），构建仍有 chunk 体积告警。

## 下一步计划

1. 把 Playwright 冒烟接到 CI，至少覆盖「登录 → 建单 → 发起申请 → 审批 → 金额变化」这条主线；这是当前唯一能把前端从「未验证」变成「已验证」的路径。
2. 处理明细行删除与审批历史的冲突（`RESTRICT` 或软删，二选一）。
3. 客户回收站、客户来源维护、标签管理 UI：三处都只有表，没有接口与界面。
4. 运营后台（admin）仍是上游模板，零业务代码。若要让运营能看租户与用量，建议从只读视图起步。
