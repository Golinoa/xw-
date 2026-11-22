# 2026-11-22 Vben 阶段 3.1：登录 / 工作台 / 通知 / 审计

本批把「认证骨架 + 三个低风险页面」从 `udone/apps/web` 迁到 `admin-clean`。
迁移基线是 `frontend-function-map.md` 的 17 页面 / 69 端点，本批覆盖 4 页（基线约 704 行）。

## 1. 做了什么

| 页面 | 新位置 | 保住的端点 |
|---|---|---|
| 工作台 `/workbench` | `views/workbench/index.vue` | `me`（成员信息）+ `notificationUnreadCount` |
| 通知 `/operations/notifications` | `views/operations/notifications/index.vue` | `listNotifications`、`markNotificationsRead` |
| 审计 `/operations/audit` | `views/operations/audit/index.vue` | `listAuditEvents`、`listAuditFacets` |
| 登录 / 忘记密码 / 设新密码 `/auth/*` | `views/_core/authentication/{login,forget-password}.vue` | Supabase Auth + `acceptInvitation` |

配套改动：

- `components/auth-captcha.vue`：Turnstile 控件移植，改成 `v-model`，可当 Vben 表单字段用；
- `components/header-widgets.vue`：公司切换 + 未读角标（挂在 `BasicLayout` 的 `#header-right-1`）；
- `lib/format.ts`：只迁当前用到的 `formatDateTime`（金额/比率等 3.2 再用再加）；
- `store/auth.ts`：新增 `recoveryMode`、`updateMember`，并修正「无成员记录」的处理（见 §2）；
- `router/guard.ts`：补回旧前端的「邀请链接可进登录页」例外（见 §2）；
- `e2e/`：新增 `workbench` / `notifications` / `audit` 三个 spec，`auth` 里两处「待实现」断言改为真实页面。

## 2. 三个必须解释的决定

### 2.1 「没有成员记录」不再算登录失败（修批次 A 的回归）

批次 A 把 `/api/me` 返回空成员当成 `FORBIDDEN` 抛出去并清会话。**这直接堵死了邀请流程**：
被邀请人第一次登录时本来就没有成员记录，而 `acceptInvitation` 需要带着 token 调，
会话被清掉就永远接受不了邀请。

反问一句「旧前端怎么做的」：旧 store 在 `loadMemberships` 失败时只写一条提示，
**会话照留**，工作台显示「当前账号尚未加入公司」。本批按旧口径改回：
保留会话、`sessionState = 'no_membership'`、工作台给出明示。
新增用例「未加入任何公司的账号进到工作台并看到提示，而不是被踢出登录」把这条钉住。

### 2.2 守卫必须放行「已登录 + 邀请链接」

旧前端守卫写着 `!(to.name === 'login' && typeof to.query.invitationId === 'string')`，
迁移时漏了。没有这一条，已有会话的人点邀请链接会被送回工作台，邀请永远生效不了。
已补回，并在注释里写明出处。

### 2.3 密码恢复必须在 `getSession()` 之前判断

Supabase 隐式流把 `type=recovery` 放在 hash 里，`getSession()` 一落地令牌就进 store，
守卫随即把人放进业务页，跳过「设置新密码」。做法：

- `hasRecoveryRedirect()` 在 `getSession()` **之前**读 hash/query；
- 恢复态只让 Supabase 客户端内部持有会话（`updateUser` 需要），**不写 `accessToken`**；
- 事件 `PASSWORD_RECOVERY` 到达时清本地态再置位（防止事件晚于初始会话到达）。

## 3. 两处「比旧页更严」的地方

1. **审计页无权限时不请求 facet**。旧页 `loadFacets()` 不看权限，`operator` 也会打
   `GET /api/audit-events/facets`（服务端虽然会拒）。本批加了 `if (!canRead) return`，
   E2E 直接断言「无权限时 `auditRequested === false`」。这是本批唯一一处有意收紧的行为。
2. **不发无用的「记住我」写入**。Vben 登录组件按 `values.username` 存 localStorage，
   而本项目字段是 `email` ⇒ 只会写入字符串 `"undefined"`。已 `show-remember-me=false`。

## 4. CAPTCHA 没有丢，且实测过

一开始判断「Vben 登录卡片没有密码框与按钮之间的插槽，插在按钮下方是错误交互」，差点降级为
「记录未做」。实际有一条干净的路：**Vben 表单的 `component` 接受组件实例**，
所以把 `AuthCaptcha` 当成一个 `fieldName: 'captchaToken'` 的字段塞进 formSchema，
位置天然正确、规则天然生效、值天然进 `values`。

验证方式（临时探针，验完即删）：用 Cloudflare 官方测试 site key
起 dev server → Playwright 打开 `/auth/login`：

```
CAPTCHA_NODE_COUNT=1        # 控件在表单里
HAS_REQUIRED_MSG=true       # 未取到 token 时提交被拦，提示「请先完成机器人验证」
TOKEN_CALLS=0               # 没有向 Supabase 发任何认证请求
```

## 5. 有意没做的

- **成员面板按 userId 更新**：原样迁移。改成「成员列表点选」需要产品口径
  （能否改自己、列表是否含停用成员等），不在本批自决，写进 §6 待办。
- **报表页**仍占位（阶段 3.2）；订单/客户/资金等 3.3–3.5 未动。
- **`oxfmt` 仍跑不起来**（二进制 `MODULE_NOT_FOUND`），`format:check` 这一档本批未跑。
- **`store/auth.ts` 仍留 13 条既有 eslint 风格错误**（`catch (cause)` 命名、
  import/union 排序、一处 `prefer-ternary`），与改动前同数，未批量修以免扩大 diff。

## 6. 验证证据

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型 | `vue-tsc --noEmit --skipLibCheck` | 0 错；**探针证明生效**（`const probe: number = 's'` → TS2322） |
| 构建 | `vite build --mode production` | ✓ 4.23s |
| E2E | `playwright test`（chrome 通道） | **12 passed / 41.7s**（原 5 条 → 12 条） |
| eslint（新增文件） | 见下 | 0 错（`--fix` 后复查） |
| oxlint | `oxlint apps/web-antd` | 7 error + 1 warning，与改动前同数（全在 `lib/api-client.ts`） |
| CAPTCHA 探针 | 见 §4 | 3 项全中 |

新增用例（7 条）：工作台 4（公司/角色/账号、管理员见成员面板、操作员不见、
无组织归属看到提示）；通知 1（列表 + 未读筛选 + 标记已读请求体）；审计 2（管理员可读、
操作员无权限且不发请求）。

## 7. 下一批

阶段 3.2：公司配置 + 审批流 / 资金 / 报表（约 916 行）。届时 `lib/format.ts` 补回
`formatMoney` / `formatRatio`（金额页要用），并开始处理「表格搜索区 + 工具栏」的统一形态。
