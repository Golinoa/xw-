# 2026-10-30 · U05 登录代理（M1 收口）

## 本轮做了什么

`o-w04` 与 `o-t03` 一起收口：三个 `POST /api/v1/ops/auth/*` 落地，运营端的 M1
（登录 → `/meta` → `/session` → `/permissions`）四段全通。提交 `c46b6b0`。

| 端点 | 行为 |
|---|---|
| `POST /auth/login` | 换令牌 → 判成员 → 发 access token + `Set-Cookie: ops_refresh=…; HttpOnly; Secure; SameSite=Strict; Path=/api/v1/ops/auth` |
| `POST /auth/refresh` | 凭 cookie 换新令牌，并回写轮换后的 cookie |
| `POST /auth/logout` | 清 cookie，204；有没有 cookie 都是 204 |

## 四处判断

1. **成员判定另开一个函数，而不是放宽 RLS。** `get_current_ops_context()` 的 WHERE
   带 `status='active'`，对「没有运营账号」与「账号被停用」**同样**返回零行——它回答
   「是不是有效成员」，不回答「为什么不是」。而契约 §5.1 要 403 带两个不同 reason，
   这两个原因指的人不同（一个要开户、一个要恢复）。另一条路是让停用账号读自己的行，
   代价是停用原因、邀请人跟着暴露，并且「读得到自己的行」与「是有效成员」从此变成
   两件事，后续每个策略都要重新判断依赖哪一个。所以新增
   `ops.login_member_state()`：无参数、`SECURITY DEFINER`、身份取自 `auth.uid()`，
   只回一个状态词。

2. **认证三端点必须跳过幂等中间件。** 幂等的语义是「同一个 key 重放同一个响应」，
   对写业务对象成立，对发令牌不成立：重放一次登录会返回**那个时刻**的 access token，
   它可能已经过期，客户端拿着回放的 200 去做下一次请求，拿到 401 且看不出原因。
   刷新更糟——它本来就要轮换令牌，重放等于把旧令牌再发一次。

3. **先验密码、后查名册，顺序不能换。** 反过来的话，未验证身份的人就能拿这个端点
   探测「哪些邮箱是运营账号」。单测里那条「密码错时 fetch 一次都没发生」的断言，
   就是钉这个顺序的。

4. **`OPS_AUTH_UPSTREAM` 是绑定，不是模块级开关。** 本地没有 `/auth/v1`
   （`db:local:*` 只起 PostgREST），登录端点若直接写 `fetch`，它的每条分支都只能在
   有真实 Supabase 项目的地方跑到。把替身做成 `Bindings` 上的一个可选对象：测试通过
   `app.request` 的第三个参数传进去，生产环境 `wrangler.toml` 里写不出来——这是类型
   保证的，不是约定。

## 验收分两段，结论也分两段

| 段 | 是什么 | 证明了什么 |
|---|---|---|
| 成员判定 | 真实 PostgREST + RLS，`ops.login_member_state()` 真跑 | 「没账号」与「被停用」两个 403 来自库里的行，不是替身编的 |
| GoTrue 上游 | 注入替身 | 只证明「拿到令牌之后做对了什么」；**不证明 GoTrue 会认这个密码** |

合成一句「登录已验证」会把上面两段的差异抹掉，而差异恰好是风险所在。

## 变异七枪，全红

| 变异 | 结果 |
|---|---|
| 去掉「状态必须 active」 | 3 条红（MISSING / INACTIVE / invited 全变成 200） |
| 两个 reason 合成一个 | 1 条红 |
| cookie 去掉 `HttpOnly` | 1 条红 |
| 403 之前先把 cookie 发出去 | 1 条红 |
| 先查名册、后验密码 | 1 条红（那条「fetch 未被调用」） |
| refresh 不回写轮换 cookie | 1 条红 |
| SQL 状态判断改成恒 `active` | pgTAP 红 2 条（invited / disabled） |

第一版变异脚本有一个坑值得记：直接 `node node_modules/vitest/...` 跑不起单文件
（pnpm 的依赖提升下 `@vitejs/plugin-vue` 解析不到），改用 `pnpm -s test <file>`；
统计行带 ANSI 颜色码，`grep "Tests"` 匹配不到，必须先剥色。两个问题都会让「变异
全绿」看起来像「断言写松了」，而实际是测试没跑。

## 门禁实测

```
format ✓   format:sql(30) ✓   lint + css tokens ✓   typecheck(含 .vue) ✓
test 44 文件 329 用例 ✓（+13）
db:local:verify 13 文件 229 断言 ✓（+6）
db:local:http 6 文件 40 条 ✓（+7）
check:deploy ✓   schema:check(17 迁移) ✓   build ✓（主 chunk 1,638.08 kB）   board:check ✓
```

## 三件未决

1. **`POST /auth/v1/logout` 的形状未经真机验证**：把 `refresh_token` 放进 JSON body
   能否撤销上游会话，取决于 GoTrue 版本与 `scope` 参数。现在失败被吞掉只记一行日志，
   登出对使用者的承诺只由「清 cookie」兑现。已登记 `o-w04b`。
2. **refresh token 是否一次性**：实现按一次性处理（每次回写轮换后的 cookie），
   若上游允许重用，这条假设就只是假设。
3. **`last_login_at` 没有写入路径**：登录成功只发令牌、不落库，`/session` 的
   `lastLoginAt` 会长期为 null。已登记 `o-lastlogin`（低优先级，不影响任何判定）。
