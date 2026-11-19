# 项目长期记忆（D:\Coding\ERP）

## 🔴 admin 依赖红线（2026-11-17 起）
**不许在沙箱里重装 `admin/node_modules`。** 39 个 workspace 的 Vben 大仓，
在 9KiB/s 网络 + 无 TTY + 沙箱锁临时文件的环境下，中断一次就留下
「88 个半解压包（`lib/` 空）+ 4 个删不掉的 `_tmp_*`」，进而让 **admin 下所有 pnpm 命令都失败**。
需要装依赖时只给用户 PowerShell 命令，让他们在自己终端跑。
识别特征：`Cannot find module '...\.pnpm\<pkg>\...\lib\index.js'`，且该目录只有 LICENSE+package.json。

### 2026-11-18 追查结论（别再重复试）
三种手法全部失败，且**都卡在同一处**（`added` 计数停在某个数后无限期不动，
顶层 `node_modules/` 始终 0 项、`.bin` 为空）：
1. 删掉残留 `_tmp_*` 后重装 —— 不再报 EPERM，但照样卡住；
2. `--offline`（不联网，只用本地 store，`reused 1712`）—— 照样卡住；
3. 把 `node_modules` 做成指向 C 盘临时区的 junction —— **pnpm 直接报
   `ENOTDIR: not a directory, mkdir ...\node_modules`**（`lstat` 下 junction 不算目录），此路不通。

**对照探针**：同样环境里一个最小包（is-odd）`pnpm install` **11 秒成功**。
⇒ pnpm 本身、网络、registry 都没问题，**是这个 39 包大仓的链接阶段在本机会挂死**。
结论：admin 前端依赖只能由用户在自己终端装；不要再在会话里尝试。

### udone 侧的两个可用变通（已验证）
- `vitest` 起不来（缺 `@vitejs/plugin-vue` 链接）：建 junction 即可 —
  `node_modules/@vitejs/plugin-vue` → `.pnpm/@vitejs+plugin-vue@<ver>/node_modules/@vitejs/plugin-vue`。
- `pnpm` 在 udone 也会被 `_tmp_*` 卡：**用 `node node_modules/vitest/vitest.mjs run` 绕过 pnpm**，
  路径要相对仓库根传；`vitest run` 跑完不退出，必须加 `timeout`，看输出里的 `Test Files` 判结果。
- 本地 PG 的数据目录放 `C:\Users\Agust\AppData\Local\Temp\%UDONE_LOCAL_PG_HOME%`，
  否则 initdb/日志会被工作区锁卡死（`UDONE_PG_BIN` 指向 `~/.udone-local-pg/pgsql/bin`）。

## 当前主线（2026-11 起）
**`udone/`（ERP 业务端：api + web + supabase 迁移）** 的业务 backlog 收尾，
清单在 `udone/Docs/superpowers/plans/2026-10-29-business-completion-backlog.md`，
每单元记录在 `udone/.harness/journal/`。

**状态（2026-11-16 晚）：计划内 39 项已交付，只剩 D2 一张。**
已完成：B1、B2、C1–C5、D1、A1、A5。
- **D2**：`ci.yml` 的 `e2e_gate` 已写好并 YAML 校验通过，A1 的 11 条用例本地全绿；
  复选框**故意未勾**——卡片要求「看到流水线真实跑过」，而本机看不了 Gitee Go 结果。
  需要用户在一次推送后到流水线页面确认 `e2e_gate` 为绿。
- 之后只剩 **C6–C12（P2，需求未开始）**：批量结算 / 账户余额 / 报表口径 / 站内通知 /
  审计日志 / CRM 线索与公海 / 公司配置，需要先出需求再拆粒度。

门禁与踩过的坑见当天日志（`.workbuddy/memory/YYYY-MM-DD.md`）。

## 项目性质
ERP 工作区，当前主线是**「云策教务」教培系统**（yunceTaro / yunce-back / yunce-admin）之外的调研项目：
**泫蜗旅行 OMS（trip.lipseo.com，飞途旅游订单系统）真实站点调研 → 一比一复刻**。
需求与口径由用户拍板，技术实现自主完成。

## 调研成果位置（只读参考，不是本系统代码）
- 主文档：`erp/docs/TRAVEL_OMS_*.md`（7 份：AI_AGENT_DESIGN / API_DRAFT / DOCS_INDEX /
  MULTITENANT_DATA_MODEL / PRODUCT_CHARACTERISTICS / REQUIREMENTS / STATE_MACHINES）
- 调研入口：`erp/docs/research/README.md`
- 证据：`research/evidence/{network_*.json, pages/*.json}`（脱敏后）
- 接口目录：`research/ACTUAL_API_CATALOG.json`、功能覆盖 `research/FUNCTION_COVERAGE.json`、
  就绪度 `research/REPLICATION_READINESS.md`、清理链 `research/TEST_CHAIN.md`

## 读证据的硬规则（踩过坑）
1. **先按 requestId 去重再谈"抓到几条"**——阶段网络文件是累加快照，同一请求会在多个文件重复出现。
2. 判断"抓到响应"要看条目有没有 `status`/`response` 字段，不能只看 URL 出现过。
3. 目录里 `capture` 字段分四档：`wire-captured` / `wire-captured-request-only` /
   `ui-submitted-not-captured` / `ui-confirmed-no-wire`，**引用前先按这个分档，别只看 evidence 里的文件名**。
4. 已经降级过的旧结论：`POST /orders/{id}/confirm-booking` 的 `status=302` 无报文支撑（只有请求侧）。

## 仍未拿到的东西（卡在外部授权，不是能力问题）
- 数据库 schema / 迁移 / 服务端代码（只读授权，最高优先）
- 第二个租户账号（做跨租户负向隔离验证）
- 导入功能入口（全站至今未发现）
- 审批**驳回/撤回**完整 UI（单账号权限不足，`/reject` 403、`/withdraw`、`/undo` 404）

## 待用户/业务决策的两项残留
- 供应商 387 删不掉：回收站内 4 条「复刻调研_」订单的应付项目引用卡住；
  唯一路径是回收站「彻底删除」（不可逆），**须用户点头才执行，不要擅自做**。
- 测试用户 90：服务端拒删，现为「禁用」仍占配额，要产品侧决定。
