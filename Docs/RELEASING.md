# 发布流程

本仓库是单仓双组件，两个子系统**独立发版**。发布由 git tag 触发，产物归档到 `artifacts/`。

## 1. tag 命名

| 组件 | 目录 | tag 形式 | 示例 |
| --- | --- | --- | --- |
| 前端 OMS + Worker | `udone/` | `udone-v<版本>` | `udone-v1.0.0` |
| 运营后台 | `admin/` | `admin-v<版本>` | `admin-v2.3.1` |

**不带组件前缀的 `v1.0.0` 会被拒绝。** 原因是 git tag 在仓库内全局唯一：单仓里 `v1.0.0` 只能指向一个 commit，无法同时表示「前端 1.0.0」和「运营后台 1.0.0」。若强行让两个组件共用 `v1.0.0`，就只能永远同时发版，违背「分别发版本」的要求。

如果确实需要纯 `v1.0.0` 形式的 tag，唯一出路是把仓库拆成两个（例如 `myc-udone`、`myc-admin`）。代价是：

- `@erp/contracts` 共享包无法再被 admin 直接引用，跨仓契约一致性失去编译期保障；
- API 变更与前端适配必须跨两个仓库协调，无法在一次提交内完成；
- 现有 `.harness/CONTRACTS.md` 的四层漂移守卫只能在 udone 内生效。

在上述代价被接受之前，不要拆仓。

## 2. 版本号唯一真源

`.release/manifest.json` 是**唯一**版本真源，两个组件的当前版本都在这里。

- 不要手改这个文件，用 `scripts/release/bump.mjs` 提升版本。
- `udone/package.json` 不设 `version`：它是 pnpm workspace 根，不是可发布包。
- `admin/package.json` 的 `version`（当前 5.7.0）属于 Vben 上游，与产品版本无关，不要改，否则会和 changeset / 上游同步打架。

## 3. 发版步骤

以发布前端 1.0.0 为例：

```bash
# 1. 提升版本（只改 .release/manifest.json）
node scripts/release/bump.mjs udone minor

# 2. 提交版本变更
git add .release/manifest.json
git commit -m "chore(release): udone 1.0.0"

# 3. 打 tag 并推送（tag 推送才会触发流水线）
git tag udone-v1.0.0
git push origin HEAD:main
git push origin udone-v1.0.0
```

先加 `--dry-run` 可以预览版本变化而不写入：`node scripts/release/bump.mjs udone minor --dry-run`。

## 4. 流水线职责划分

三条流水线都在仓库根的 `.workflow/`（Gitee Go 只读这个位置，放到子目录等于没有流水线）。

| 文件 | 触发 | 职责 |
| --- | --- | --- |
| `ci.yml` | push / PR 到 `main` | 日常质量门禁，不产出产物 |
| `release-udone.yml` | tag `udone-v*` | 校验版本 → 全量门禁 → 构建 → 归档 |
| `release-admin.yml` | tag `admin-v*` | 校验版本 → admin 门禁子集 → 构建 → 归档 |

两条发布流水线的前缀不重叠，且**只配 `tags` 不配 `branches`**。Gitee Go 的 `branches` / `tags` / `commitMessages` 是交集关系，同时配置会让普通分支推送也命中发布流水线。

流水线里取 tag 名用 `git tag --points-at HEAD --list 'udone-v*'`，不依赖平台环境变量——Gitee Go 未公开稳定的 tag 变量名，假设它存在会让发布静默失败。

## 5. 产物

```
artifacts/
  udone-1.0.0.tar.gz          # apps/web/dist
  udone-1.0.0.tar.gz.sha256
  udone-1.0.0.json            # 组件/版本/tag/commit/构建时间/sha256
```

Worker 没有独立 bundle（`wrangler deploy` 时现场打包），部署时需从对应 tag 检出仓库再执行
`pnpm --filter @erp/api exec wrangler deploy`。

`artifacts/` 已加入 `.gitignore`，不会入库。

## 6. admin 的工具链约束

`admin/scripts/quality/check-toolchain.mjs` 是 `preinstall` 钩子，对 Node 与 pnpm 做**字符串相等**比较：
Node 必须是 `24.20.0`，pnpm 必须是 `10.33.4`（见 `admin/.node-version` 与 `package.json` 的 `engines`）。

所以 `release-admin.yml` 里 `nodeVersion` 写死 `24.20.0`，不能写 `24`。

**若 Gitee Go 镜像没有 24.20.0**，流水线会停在预检并打印实际版本。此时应同步调整 `.node-version`、`package.json` 的 `engines`、以及 `release-admin.yml` 三处，而**不是**放宽 `check-toolchain`。

admin 发布刻意不跑 `quality:check`：它内含 `quality:dependencies`，而依赖基线仍有无补丁的高危 advisory，一跑必红，会把发布链路整体卡死。等依赖基线清理后再纳入。

## 7. Gitee 侧需要人工完成的事

以下步骤无法由代码完成，首次发布前必须确认：

1. 在仓库「流水线」页面确认三条流水线已被识别（Gitee Go 读取 `.workflow/`，需要有权限的账号先开通 Gitee Go）。
2. 手动触发一次 `release-udone`，或推一个真实 tag，确认能跑通。
3. 验证隔离性：推一个 `udone-v*` tag 后，确认**只有** `release-udone` 被执行，`release-admin` 与 `ci` 未被误触发。若 `ci` 也被触发，说明 tag 推送同样命中了 `branches` 规则，需要在 `ci.yml` 的 `triggers.push` 下补 `tags` 排除项。
4. 确认产物在构建页可下载，且 `artifacts/*.json` 里的 `sha256` 与压缩包一致。

在这些验证完成前，`udone/.github/workflows/ci.yml`（从未执行过的 GitHub 工作流）不要删除，也不要声称 CI 已生效。

## 8. Worker 的环境变量与密钥

变量清单有**两处真源，键集合必须相同**，由 `pnpm check:deploy` 强制：

| 文件 | 用途 | 是否入库 |
| --- | --- | --- |
| `udone/.env.example` | 文档：每个键为什么存在 | 是，值必须为空占位 |
| `udone/.dev.vars.example` | 本地填法：`cp` 成 `.dev.vars` 后被 `wrangler dev` 加载 | 是，值必须为空占位 |
| `udone/.dev.vars` | 本地实际值 | 否（`.gitignore`） |

生产不走这三个文件，用 `wrangler secret put <NAME>` 注入；**`wrangler.toml` 只放 `APP_VERSION` 这类非密钥值**。

### 8.1 必须由人提供的五个值

| 变量 | 从哪取 | 缺失的后果 |
| --- | --- | --- |
| `SUPABASE_URL` | Supabase → Settings → API | Worker 起不来（类型上必填） |
| `SUPABASE_PUBLISHABLE_KEY` | 同上 | 同上 |
| `SUPABASE_SERVICE_ROLE_KEY` | 同上 | 同上；**只给 Worker，绝不许下发到浏览器** |
| `SUPABASE_JWT_SECRET` | 同上，JWT Secret | 能起服务，但幂等命名空间退化为令牌哈希：access token 一刷新，同一笔重复提交就落两行 |
| `APP_BASE_URL` | 部署域名 | 邀请接口不返回可点链接 |

`SUPABASE_JWT_SECRET` 在类型上是可选的（本地无 GoTrue 也要能起服务），所以它**不会**在启动时失败——这正是它被写进 `check:deploy` 清单的原因：名字一旦从样例里消失，门禁红，而不是等到线上出现重复单。

### 8.2 有可用默认的策略值

`ALLOWED_ORIGINS`（默认两条 localhost，**禁通配符**，留空即拒绝所有跨域）、`RATE_LIMIT_PER_MINUTE`（默认 60）、`ALLOW_LOCAL_JWT_AUTH`（样例必须 `false`）。

`ALLOW_LOCAL_JWT_AUTH` 的两条硬约束：`.env.example` 里必须是 `false`；`wrangler.toml` 里**出现这个名字就失败**，不看值——关掉的写法有很多种，而「配了没生效」与「配了且生效」在部署日志里长得一样。

### 8.3 真栈冒烟专用

`SMOKE_*` 七个键只在 `pnpm smoke` 指向已部署环境时填，且必须用专用测试账号与一个专门的组织——不要指向生产数据。本地 `db:local:*` 用夹具，不需要这些键。

## 9. 已知未覆盖

- **没有自动部署**。发布只做构建与归档，部署仍是手动动作。
- **`deps:audit` / `licenses:check` 未纳入发布门禁**，原因见第 6 节与 `.harness/CONTRACTS.md`。
- **产物没有签名**，只有 sha256 校验和。
- **流水线未在本机验证过**：Gitee Go 只能在平台执行，本地验证覆盖的是 tag 解析、版本一致性、格式与语法。
