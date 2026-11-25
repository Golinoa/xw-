# 2026-11-26 阶段 4：把「上线决策」变成可执行的 4 步清单

## 背景：这一轮没有卡片可做，但有一个说不清的决策

业务 backlog 21/21 全勾（`grep "^- \[ \]"` = 0），Vben 迁移阶段 0–4 也全部完成
（17 页 + 门禁 + E2E 36 passed，run `45651616866`）。剩下唯一一项是
「默认路由切新工程 / 旧 `apps/web` 留一版回退」。

前几轮的处理方式是「等用户拍板」，等于把一份**没有具体内容的决策**丢回给用户：
他没法定——不知道切一下要改几个文件、会不会把 CI 弄红、产物能不能直接部署。
这轮把这三个问题全部用探针答掉，让决策退化成一句话。

## 做了什么

只改文档，不动一行运行代码（切换本身是用户的决策，不该由自动化替他执行）。

1. `udone/.harness/docs/vben-migration-plan.md`：阶段 4 新增「切换清单（2026-11-26 实测）」，
   4 条改动 + 3 条证据；表格行与末尾「阶段 4 剩余项」指向它。
2. `udone/Docs/superpowers/plans/2026-10-29-business-completion-backlog.md` §9：**纠偏**。
   原文写着「下一批是阶段 3.1」——那是 11-22 的快照，3.1–3.5 与阶段 4 早已完成。
   巡检脚本按它取下一张卡，会取到一张早就做完的卡。现在写明「无剩余卡 + 唯一外部条件」。

## 三条实证（不是估算）

### 1. 跨出 `udone/` 的 assets 目录可用

`wrangler.toml` 在 `udone/`，新前端产物在 `admin-clean/apps/web-antd/dist`，必须写 `../`。
没有文档承诺过 wrangler 接受仓库外的相对路径，所以直接跑探针：

```
目录 = ../admin-clean/apps/web-antd/dist
✨ Read 253 files from the assets directory D:\Coding\ERP\admin-clean\apps\web-antd\dist
Total Upload: 1623.06 KiB / gzip: 266.99 KiB
--dry-run: exiting now.
```

结论：**可用**。附带一个环境现象：dry-run 打印结果后进程不退出（被 `timeout` 收掉，EXIT=124），
与本机 Playwright 收尾卡住同类，不影响判定。探针配置 `.probe-wrangler.toml` 用完已删。

### 2. 只改 toml 会让 `check:deploy` 立刻红

`udone/scripts/check-deploy-config.ts` 的 `WRANGLER_REQUIREMENTS` 里是**字面量断言**：
`'directory = "apps/web/dist"'`。它守的是「别把 assets 指到乱七八糟的地方」，
代价就是换前端时必须同步改这一行。这是切换的实际步骤之一，不是可选项。
（`udone-ci` 里它是第 8 步「部署配置」，排在前面的 7 步都没问题也拦得住。）

### 3. CI 的 `web-antd-dist` artifact 不能直接部署（且这不是迁移引入的）

新前端 `apps/web-antd/src/lib/supabase.ts` 只读 `import.meta.env.VITE_SUPABASE_URL` /
`VITE_SUPABASE_PUBLISHABLE_KEY`，这两个值只在被 gitignore 的 `.env.local` 里
（`admin-clean/.gitignore:36`，`git ls-files --error-unmatch` 报未跟踪）。仓库 Actions secrets
实测 **0 个**：

```
GET /repos/Golinoa/xw-/actions/secrets → {"total_count": 0, "secrets": []}
```

所以 `web-antd-build.yml` 的 build job 产出的是一个**能构建、不能登录**的产物
（登录时会走 `store/auth.ts` 的「登录服务尚未配置」分支）。

**重要：旧 `apps/web` 是同一套做法**（`apps/web/.env.local`、同样未提交、
`lib/supabase.ts` 同样读 `import.meta.env`）。所以这是既有的发布方式——
构建机上放 `.env.local`——而不是迁移的缺口。写进文档是为了防止有人拿 CI artifact 上线，
不是为了顺手「修」出一个新门禁（那会让现在绿的 CI 立刻变红，而补 secret 是用户的平台动作）。

## 没做什么 / 为什么

- **没有真的执行切换**：这是业务决策（什么时候对外换界面、旧版留多久回退），
  按《自动化硬规则》该由用户拍板，不能因为「自动化要推进」就替他上线。
- **没有加「构建时缺 env 就失败」的门禁**：那会让 `web-antd-build.yml` 立即红，
  而修红需要用户去配 secret（我拿不到、也不该伪造）。等切换时一并定。
- **没有回放 pgTAP / vitest / HTTP 集成**：本轮零运行代码改动，纯文档。
  `format:check` 的 glob 是 `*.{js,ts,tsx,vue,json,yml,yaml}`，**不含 `.md`** ⇒ 文档格式不在门禁内。
- **没有碰根目录 16 个未跟踪脚本**（`scripts/i18n-phase*.json`、`local-preview-server.mjs` 等）：
  是用户侧预览工具，不是我该删的东西；已在交付说明里第三次标出来。

## 给下一轮的判据

计划文件里所有 `- [ ]` 都已不存在（`2026-10-03-mvp-and-launch.md` 的 39 个是**过期复选框**，
文件头已声明执行态以 business-completion-backlog 为准）。
⇒ **除用户拍板切换之外，没有可做的技术工作。** 再空转就只回一句，并建议把间隔拉长到 1 天。
