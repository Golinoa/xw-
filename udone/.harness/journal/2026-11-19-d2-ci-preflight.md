# 2026-11-19 D2 预检：把「流水线到底会不会过」从猜测变成证据

D2 的格子一直没勾，理由是「本机看不到 Gitee Go 结果」。但那是**观察**问题；
在观察不到的前提下，唯一能做的事是**排除已知会红的点**。这次就做这件事，
结果发现了一个真会让流水线在第一步红的缺陷。

## 1. `format:check` 一直是红的，但红得没有信息量

本机工作区所有文件都是 CRLF（`git config core.autocrlf` = `true`），
而 `udone/.prettierrc.json` 写的是 `endOfLine: "lf"`。于是：

```
pnpm format:check → Code style issues found in 207 files
```

**207 个文件全红 ⇒ 这条门禁在本机等于没有信号**，前几轮的结论一直是
「CRLF 环境噪音，忽略」。这个判断只对了一半。

## 2. 用 CI 的视角看：仓库里存的是 LF，问题只剩 4 个文件

CI（Linux 检出）看到的是 blob 原文，即 LF。要复现它必须绕开工作区：

```bash
git -c core.autocrlf=false -c core.eol=lf archive HEAD --format=tar \
  -o "C:/Users/.../head.tar"
cd <解包目录>/udone
node <repo>/udone/node_modules/prettier/bin/prettier.cjs --check <与 package.json 同一组 globs>
```

修前结果：**4 个文件**不合规（不是 0，也不是 207）。

| 文件 | 差异 |
|---|---|
| `apps/api/src/modules/ops/auth/routes.ts` | 连续两个空行 |
| `apps/web/src/views/customers/CustomerRecycleBinView.vue` | 两处行宽未换行 |
| `tests/e2e/order-finance-flow.spec.ts` | import 与链式调用行宽 |
| `tests/e2e/order-list-states.spec.ts` | 链式调用行宽 |

CI 的 `quality_gate` **第一行**就是 `pnpm format:check` ⇒ 这 4 个文件足以让
流水线在任何业务代码被检查之前就判失败。与代码质量无关，纯格式。

> 复现这一步踩了三个坑，记下来免得下次重踩：
> 1. `git archive` **会吃 `core.autocrlf`**——不关掉，导出的还是 CRLF，
>    于是又得到 213/347 个「不合规」，数字看着更像环境问题，实则是我自己造出来的。
> 2. `git` 是 Windows 二进制，`-o /c/Users/...` 这种 MSYS 路径它打不开，
>    要写成 `C:/Users/...`。
> 3. `node /d/.../prettier.cjs` 会被拼成 `C:\d\...`，同样要用 `D:/...`。
>
> 判据：导出后先 `tr -cd '\r' | wc -c` 确认是 0，否则测的不是 CI 的东西。

## 3. 修法：只改这 4 个文件

提交 `646f28e`，15 insertions / 18 deletions，全部是空行与换行位置。

**没有**顺手把 207 个 CRLF 文件批量改写成 LF。理由：那会把一次格式修复变成
一次全仓重排，`git blame` 与历史 diff 全部失效，而 CI 侧本来就不需要它
（检出即 LF）。同理没有加 `.gitattributes`——它只影响检出，
真正让本机 `format:check` 变可信还得重写全部工作区文件，收益不抵风险。

修后同一命令复验：**All matched files use Prettier code style**（0 不合规）。

## 4. 顺手排掉的另外两个「CI 才会炸」的点

**lockfile 是否过期**：`pnpm install --frozen-lockfile` 遇到锁文件与
package.json 不一致会直接 `ERR_PNPM_OUTDATED_LOCKFILE`，整条流水线第一步就死。
用一次性脚本比对了 `pnpm-lock.yaml` 的 4 个 importer（`.`、`apps/api`、
`apps/web`、`packages/contracts`）与对应 package.json 的
`dependencies` / `devDependencies` 声明：**逐项一致，无缺失、无漂移、无多余**。
（探针用完即删，未入库。）

**E2E 在 CI 模式会不会挂住**：上一轮记过「全量 E2E 跑完不退出，要 timeout 收尾」，
一直没搞清是不是流水线风险。这次用 `CI=1`（强制不复用外部 dev server，
即 CI 的真实行为）跑全量：

```
CI=1 E2E_PORT=4191 node node_modules/@playwright/test/cli.js test
→ 24 passed, 1 skipped (25.6s)，退出码 0
```

**结论：不挂。** 之前的「跑完不退出」只出现在复用外部 dev server 的场景
（`reuseExistingServer: !process.env.CI`），CI 里 playwright 自己拉起、
自己杀掉，行为干净。这是对上一轮那条待确认项的正面回答。

## 5. 门禁

- `format:check`（CI 视角，LF 导出）：**0 不合规**（修前 4 个文件）
- `typecheck`：api + web 通过
- `eslint`（改动的 4 个文件）：通过
- E2E：全量 24 通过 1 跳过 / 退出码 0；改动的两个 spec 单跑 3 通过
- 本机工作区 `format:check` 仍是 207 红 —— **这是 autocrlf 的必然结果，
  不是回归**，不要拿它当门禁信号，按上面第 2 节的方式看

## 6. 没做什么

- **没有勾 D2**：卡片要求「看到流水线真实跑过」。本机仍读不到 Gitee Go
  （缓存的 git 凭据是 9 位账号密码，Gitee OpenAPI 已不接受密码认证，实测 401），
  平台侧还需在网页端「新建流水线」并贴入根目录 `.workflow/ci.yml`。
  这次只是把「红的原因」从代码里清掉了，剩余的是平台动作。
- 没有加 `.gitattributes`，也没有批量重排换行符（理由见第 3 节）。
- 没有动 `format:sql:check` 的既有 66 文件 CRLF 问题：同理，且它不在 CI 门禁里。
