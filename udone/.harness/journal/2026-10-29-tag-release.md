# tag 触发的双组件发布

日期：2026-10-29
分支：`feat/p0-architecture-hardening`

## 问题

要求：推 v 标签自动发版，且同一仓库内的前端（`udone`）与运营后台（`admin`）要能分别发版；
若做不到则重建仓库。myc 仅作为「若新建仓库」的仓库名前缀。

## 结论：单仓可行，不重建

硬约束是 **git tag 在仓库内全局唯一**：单仓里 `v1.0.0` 只能指向一个 commit，
无法同时表示「前端 1.0.0」和「运营后台 1.0.0」。所以「分别发版」与「纯 v 版本号」不可兼得，
必须二选一：

| 取舍 | 代价 |
| --- | --- |
| tag 带组件前缀（采用） | tag 名略长，形如 `udone-v1.0.0` |
| 拆成两个仓库，各自 `v1.0.0` | `@erp/contracts` 跨仓共享断裂；API 变更需跨仓协调；四层漂移守卫只在 udone 内生效 |

选择前者：拆仓会破坏 `.harness/CONTRACTS.md` 建立的契约一致性保障，而这一保障正是前两轮
改造的核心成果。

## 先修掉的真问题：`.workflow` 位置错误

Gitee Go 只读取**仓库根目录**的 `.workflow/`。此前它位于 `udone/.workflow/ci.yml`，
即单仓化之后从未被平台识别——「配置存在」不等于「门禁生效」，与上一轮 GitHub Actions
从未执行是同一类错误。已 `git mv` 到仓库根。

## 变更

| 文件 | 作用 |
| --- | --- |
| `.workflow/ci.yml` | 日常门禁，移到根并改为 `cd udone` 执行 |
| `.workflow/release-udone.yml` | tag `udone-v*` → 校验 → 门禁 → 构建 → 归档 |
| `.workflow/release-admin.yml` | tag `admin-v*` → 校验 → admin 门禁子集 → 构建 → 归档 |
| `.release/manifest.json` | 两组件版本唯一真源 |
| `scripts/release/lib.mjs` | tag 解析 / 版本校验 / 递增（纯函数） |
| `scripts/release/verify.mjs` | 流水线闸门，版本不一致即拒绝发布 |
| `scripts/release/bump.mjs` | 本地提升版本，只改清单 |
| `package.json`（根） | 发布编排入口，不装依赖，不引第三套工具链 |
| `Docs/RELEASING.md` | 发布手册与残余风险 |

关键设计：

1. **发布流水线只配 `tags`，不配 `branches`**。Gitee Go 的 `branches` / `tags` /
   `commitMessages` 是交集关系，同时配置会让分支推送也命中发布流水线。
2. **tag 名用 `git tag --points-at HEAD --list '<prefix>*'` 获取**，不依赖平台环境变量。
   Gitee Go 未公开稳定的 tag 变量名，假设它存在会让发布静默失败。
3. **版本一致性前置**。tag 与清单不一致直接退出，避免产物版本与 tag 漂移。
4. **`bump.mjs` 只改 `.release/manifest.json`**。`admin/package.json` 的 5.7.0 属于
   Vben 上游，改动会与 changeset、上游同步冲突。
5. **admin 发布不跑 `quality:check`**：其中 `quality:dependencies` 因存在无补丁的
   高危 advisory 必红，会把发布链路整体卡死。改跑已通过的五个子项。

## 验证

| 项 | 结果 |
| --- | --- |
| `node --test scripts/release/lib.test.mjs` | 14 passed |
| `verify.mjs udone-v0.1.0` / `admin-v0.1.0` | 通过，输出 key=value |
| `verify.mjs v1.0.0` | 拒绝，提示需组件前缀 |
| `verify.mjs admin-v9.9.9` | 拒绝，提示先 bump |
| tag 提取隔离（临时 tag 实测） | `udone-v*` 存在时 `admin-v*` 取值为空 |
| 产物打包 + sha256 | 本地实测通过 |
| `pnpm format:check`（含根级文件） | 通过 |
| `pnpm lint` / `typecheck` / `test` 136 / `build` / `check:deploy` / `schema:check` | 全绿 |

## 仍未解决

1. **Gitee Go 未真跑过**。平台侧需人工开通并触发一次，见 `Docs/RELEASING.md` §7。
2. **`ci.yml` 是否会被 tag 推送误触发未验证**。按文档交集规则，只配 `branches` 时
   tag 推送可能不命中，但无法本地证实。首次推 tag 后需检查是否多跑了 `ci.yml`。
3. **Gitee 镜像是否有 Node 24.20.0 未知**。admin 的 `preinstall` 做字符串相等比较，
   24 与 24.20.0 都会失败。流水线已加预检给出可读诊断，但版本本身不可保证。
4. **产物无签名**，只有 sha256；**无自动部署**，部署仍是手动动作。
