# 2026-11-20 D2 回放：把 `ci.yml` 的每一步在本地按顺序跑一遍

D2 的格子仍然不能勾——原因没变（本机看不到 Gitee Go 结果，平台侧流水线对象还没建）。
既然观察不到，就把**观察能覆盖的部分压到最小**：上一轮证明了「格式这一步不会再红」，
这一轮证明**整条流水线的每一步都不会红**，并且顺手把一个被误判了两轮的门禁重新诊断清楚。

## 1. 做法：照 `ci.yml` 的 goals 顺序原样回放

不做任何「跳步」或「用等价的轻量检查代替」，因为那样证明的东西就变了。
唯一的两处偏离，都写在下面第 5 节的理由里：`pnpm install --frozen-lockfile` 与本机
`format:check` 的 CRLF 问题。

| # | 步骤（ci.yml 顺序） | 结果 | 耗时 |
|---|---|---|---|
| 0 | `format:check`（按 CI 检出内容：LF 导出） | ✅ 0 不合规 | ~10s |
| 1 | `format:sql:check`（**不在 ci.yml 里**，DoD 要求） | ❌ 25 个文件（见第 3 节） | 5s |
| 2 | `lint`（eslint + CSS token） | ✅ | 10s |
| 3 | `typecheck`（api + web） | ✅ | 11s |
| 4 | `test`（vitest） | ✅ **74 文件 / 925 用例** | 13.6s |
| 5 | `build`（web + api 生产构建） | ✅ | 13s |
| 6 | `schema:check` | ✅ 61 个迁移与 schema 清单一致 | 2s |
| 7 | `check:deploy` | ✅ | 3s |
| 8 | `e2e`（`CI=1`，25 条） | ✅ **24 通过 1 跳过**，退出码 0 | 23.2s |

第 8 步的 `CI=1` 是关键：它让 `reuseExistingServer` 失效，playwright 自己拉起
vite 再自己杀掉，与流水线行为一致。1 条跳过仍是缺 CAPTCHA site key 那条，属既有。

**结论：`.workflow/ci.yml` 的两个 step 在本地按序回放全绿**（唯一红的是它没纳入的
`format:sql:check`）。也就是说，用户把流水线建起来、推一次，预期看到的是绿；
剩下的不确定性只剩运行镜像本身（Node 24 + apt 装 Chromium 依赖）。

**关于 Node 版本差异**：CI 用 `nodeVersion: "24"`，本机默认 22.22.2。
用系统 Node 24.22.1 复跑了单测（最能暴露版本差异的一步，因为它同时跑 vite 转换链路）：
**74 文件 / 925 用例同样全绿**。构建未在 24 下复跑——收益低，且 vitest 已覆盖转换链路。

## 2. `format:check`：这次是干净结论

沿用上一轮唯一可信的办法（LF 导出 + CI 同一组 globs），在 `2fb4d5c` 上复验：
导出内容 CR 计数 **0**，prettier `--check` → **All matched files use Prettier code style**。
自上次修复后新增的两个提交只动 `.md`（不在 glob 内），所以没有新债。

## 3. 纠错：`format:sql:check` 的红不是 CRLF 噪音，是真的有 25 个文件

上一轮（`2026-11-19-d2-ci-preflight.md` 第 100 行）写的是
「不动 `format:sql:check` 的既有 66 文件 CRLF 问题」。**这个判断是错的**，重新测：

1. 工作区直接跑 → 26 个文件「需要格式化」。
2. 把源文件做 `\r\n → \n` 归一化后，再用 `sql-formatter` 同样的 options 比对 → **仍有 25 个文件不一致**。
   ⇒ 只有 `20261031000011_ops_settings_dictionaries.sql` 一个是纯 CRLF 造成的假红，
   其余 25 个是真的格式漂移（集中在 2026-11-15 之后新增的迁移与 pgTAP）。

3. 差异形态决定了**不该**用 `--write` 抹平它。抽样：

```
-  pg_catalog.count(*)::integer
+  pg_catalog.count (*)::integer          ← 函数名与括号之间插了空格

-  route_type text CHECK (route_type IS NULL OR length(btrim(route_type)) > 0),
+  route_type text CHECK (
+    route_type IS NULL
+    OR length(btrim(route_type)) > 0
+  ),                                       ← 一列 DDL 被拆成 4 行
```

表单化后比手写更难读，且会重排 25 个**已提交的迁移文件**（135 行 → 151 行这类膨胀）。
所以本轮**不格式化**，也不给脚本加白名单（那是把门禁改成永远绿）。

**它不影响流水线**：`ci.yml` 的 goals 里没有 `format:sql:check`（第 12–15 行明确写了
只跑 format / lint / typecheck / test / build / schema:check / check:deploy）。
它只是 backlog「完成定义」里列的一项，属于文档与现实的落差，不是回归。

> 这属于「范围外发现，按规矩当场说」：要么统一格式化 25 个文件（churn 大、可读性变差），
> 要么把脚本改成「先做换行归一化再比对、且仅对新增迁移强制」。
> 两条都不是本轮 D2 该顺手做的事，留给用户拍板。

## 4. 没做什么

- **没有勾 D2**。卡片要求「以实际跑通为准」，本机读不到流水线结果
  （缓存凭据是账号密码，Gitee OpenAPI 拒绝密码认证，实测 401，这条别再试）。
  仍需用户在 `gitee.com/rainy_morningh/ERP` →「流水线」→ 新建 → 粘根目录 `.workflow/ci.yml`。
- **没有跑 `pnpm install --frozen-lockfile`**：本机 `node_modules` 已是安装态，
  而这个沙箱里 udone 的 pnpm 链接阶段会被 `_tmp_*` 卡死（记忆里有记录，别再试）。
  lockfile 与 4 个 importer 的一致性上一轮已逐项核对过，不受影响。
- **没有跑 `db:local:verify`（pgTAP）**：本轮零代码改动，且 `ci.yml` 刻意不纳入 pgTAP
  （需要本地 PostgreSQL）。没有新迁移 ⇒ 重跑不会产生新信息。
- 没有清理 `apps/{api,web}/.nm-bad/`：`.gitignore` 已覆盖，只影响本机磁盘噪音。

## 5. 验证证据

- 回放日志（本机临时文件，未入库）：`%TEMP%\ci-replay.log`，每步 `=== STEP <name> RC=… SEC=…`
- LF 导出复验目录：`%TEMP%\d2-fmt`（先确认 CR 计数 0 再下结论）
- 工作区在回放前后均为干净（`git status --porcelain` 空），回放不产生任何磁盘改动
  （探针脚本用完即删，`.d2-*.mjs` 未入库）
