# 2026-11-20 D2：三份 `ci.yml` 收敛成一份会跑的那份

D2 还是不能勾——两条流水线都还没在平台上真跑过一次。但这一轮不是空转：
仓库里其实有**三份** `ci.yml`，其中一份**永远不可能被执行**，而单测偏偏守着那一份。
「CI 已覆盖 deps:audit / licenses / secrets」这个结论，一直是纸面上的。

## 1. 真问题：GitHub 只读仓库根，子目录那份是装饰品

| 文件 | 谁在执行 | 实际状态 |
|---|---|---|
| `.workflow/ci.yml` | Gitee Go | 有效，但要先在网页端建流水线对象（无凭据 ⇒ 从未跑过） |
| 根 `.github/workflows/ci.yml` | GitHub Actions | 今天 08:35 新增；无 GitHub remote ⇒ 从未跑过 |
| `udone/.github/workflows/ci.yml` | **没有人** | GitHub 不扫子目录 ⇒ **永远执行不到** |

第三份不是无害的摆设，它有两处实际危害：

1. `tests/tooling/harness-config.test.ts` 的「pins CI to local commands」那条断言
   `read('.github/workflows/ci.yml')`，读的正是 `udone/.github/workflows/ci.yml`。
   于是测试常年绿着，断言的门禁清单（`deps:audit`、`licenses:check`、`secrets:check`、
   `secrets:canary:check`、`db:test`、`format:sql:check`）**一条都没在 CI 里跑过**。
   这与 journal `2026-11-19-g1-g3-final-gaps.md` 里记的 `a-deps-biz` 是同一种病：
   「没发现问题」和「没去查」显示成一样。
2. 根目录那份（真正会跑的）比它少了 5 道门禁，而没人发现——因为没人拿两份对比过。

**决定：留根目录那份做唯一真源，删掉子目录那份，并把断言改成指向真源。**
理由不是「哪个内容更好」，而是**哪份会被执行**。留着一份不执行的副本，等于给自己
留一张假收据。

历史背景（避免下次又推翻）：`Docs/superpowers/plans/2026-10-29-p0-architecture-hardening.md`
曾计划「GitHub Actions 下线、只留 Gitee Go」，但当时因为「托管 CI 没跑通前不删」而搁置；
今天用户拍板要一套 GitHub 版。于是现状是**两个平台各一条流水线**，这没问题；
有问题的是**同一个平台下有两份**。

## 2. 做了什么

1. **重写根 `.github/workflows/ci.yml`**（唯一活文件）
   - 三个 action 钉到 commit SHA（沿用被删那份的 v4.2.2 / v4.1.0 / v4.4.0），
     `upload-artifact` 仍用 `@v4` 标签并在文件里注明。
   - 补 `permissions: contents: read`（默认令牌不该带写权限）。
   - `quality` job 15 步：安装 → format:check → lint → typecheck → test → build →
     schema:check → check:deploy → deps:audit → licenses:check → secrets:check →
     secrets:canary:check。**后四道是这次从死文件里救回来的**，本机逐条实测全绿才加。
   - `e2e` job 独立成 job（Chromium ~150 MB + 系统库），保留「退出码 124 只在
     日志有 passed 且无 failed 时放行」的判定，保留失败现场上传。
   - 文件头写清**刻意不纳入**的两项及理由（见第 4 节），避免下次被人当成漏项补回去。
2. **删除** `udone/.github/workflows/ci.yml`（`git rm`）。
3. **改断言** `tests/tooling/harness-config.test.ts`：读根目录文件；断言清单换成真实门禁；
   新增两条反向断言——`playwright install --with-deps chromium` 必须存在（删掉它就能让
   用例「假装通过」），子目录里 `udone/.github/workflows/ci.yml` 必须**不存在**。
4. **格式门禁覆盖根 `.github`**：`format:check` / `format:write` 的 glob 增加
   `"../.github/**/*.{yml,yaml}"`。此前只覆盖 `udone/.github` 与 `../.workflow`，
   于是**真正会跑的那份配置反而不在格式门禁里**。
5. **文档纠偏**：`ENGINEERING_STANDARDS.md` §4 原文说 `.github/workflows/ci.yml`
   把 `db:local:verify`、`db:local:http`、`format:sql:check` 都跑了——三件都不在
   任何流水线里。改成逐平台列清实际步骤，并写明「GitHub 只读仓库根，子目录副本不执行」。
   `CONTRACTS.md` 遗留项 5 补一句「子目录那份已删，别再建第二份」。

## 3. 验证证据

**新加的四道门禁在本机先跑一遍再写入流水线**（不写没跑过的命令）：

| 命令 | 结果 |
|---|---|
| `pnpm secrets:canary:check` | 退出 0，输出「Secret scanner rejected and redacted the synthetic canary.」 |
| `pnpm secrets:check` | 退出 0 |
| `pnpm licenses:check` | 退出 0，`License policy passed for 349 installed package groups.` |
| `pnpm deps:audit` | 退出 0，`critical 0 / high 0 / moderate 5 / low 1`，白名单 0 条 |

**YAML 结构**（PyYAML 解析）：`jobs = [quality, e2e]`；quality 15 步、e2e 7 步；
`permissions = {contents: read}`。（`on:` 被 PyYAML 读成布尔键 `True` 是 YAML 1.1 的
已知行为，GitHub 侧按规范解析，不是问题。）

**变异验证**（两条新断言都真的会红）：

| 变异 | 结果 |
|---|---|
| 把 `pnpm e2e` 改成 `pnpm exec playwright test` | `1 failed | 10 passed`，报 `to contain 'pnpm e2e'` |
| 在 `udone/.github/workflows/` 放回一份 | `1 failed | 10 passed`，报 `expected true to be false` |
| 恢复 | `11 passed (11)` |

**门禁**：单测 **74 文件 / 925 用例**全绿（与改动前同数，没有用例被吞）；
`pnpm lint`（eslint + CSS token）通过；改动文件按 **LF 副本**跑 prettier 全部合规
（工作区直接跑会因 CRLF 假红，这是本机既有噪音）。

## 4. 刻意没做，及理由

- **`format:sql:check` 不进任何流水线**。存量 25 个迁移与 `sql-formatter` 输出不一致，
  而 formatter 的输出更差（`count(*)` → `count (*)`、单行 `CHECK` 拆成 4 行）。
  加进去等于要求「为了让门禁变绿而重排所有已提交迁移」。判据见 D2 卡片。
  注意：`harness-config.test.ts` 里原有的「CI 必须包含 format:sql:check」断言因此**删掉了**——
  它不是被悄悄削弱的门禁，而是一个从来没有被执行过的幻觉。
- **`db:test`（pgTAP）不进流水线**。需要 Docker + Supabase CLI，本机两样都没有，
  这条路径从未验证过。硬塞进去只会得到一条无法复现的红，或者一条没人敢信的绿。
  数据库行为仍由本地 `db:local:verify` / `db:local:http` 负责。
- **没给 `deps:audit` 加 `continue-on-error`**。它是策略门禁（白名单带到期日），
  会红是它的职责；用 `continue-on-error` 抹平就等于又造一个「门禁但不会红」。
- **D2 的格子仍然不勾**。两件事仍未发生：Gitee Go 里没有流水线对象；仓库没有 GitHub
  remote。没有真实运行记录就不算接入完成。

## 5. 顺带排掉的「Linux 上才会红」的风险

这三条在 Windows 上永远测不出来，是流水线首跑最容易翻车的地方，逐个拿证据排掉：

| 风险 | 探针 | 结果 |
|---|---|---|
| 相对导入大小写不一致（Linux 区分大小写） | 扫 `apps/packages/tests/scripts` 全部相对导入，逐段做**精确大小写**校验 | 856 条导入，**0 处**不一致 |
| lockfile 只含 Windows 平台二进制，ubuntu 上装不出 rollup/esbuild | 查 `pnpm-lock.yaml`（v9.0）平台包 | 含 `@rollup/rollup-linux-*`、`@esbuild/linux-x64` 等，`linux` 出现 172 处 ⇒ 不会缺 |
| 存在 `.only`（vitest 在 CI 下 `forbidOnly` 直接失败） | grep `it.only` / `test.only` / `describe.only` | 0 处 |
| 把 `packageManager` 写成不存在的 pnpm 版本 | `pnpm -v` | 11.24.0，与 `package.json` 一致 |

另外确认 `playwright.config.ts` 的 `webServer` 走 `pnpm --filter @erp/web dev`（vite dev），
**不依赖 `dist/`**——所以 `e2e` job 不需要先 `pnpm build`，两个 job 可以并行。

## 6. 下一步（都不是我能代办的）

1. Gitee 侧：`gitee.com/rainy_morningh/ERP` → 流水线 → 新建 → 粘贴根 `.workflow/ci.yml`。
2. GitHub 侧：建仓库 + `git remote add github ...` + 推一次，看 `udone-ci` 两个 job 是否绿。
3. 任一平台跑绿之后，D2 才能勾。
