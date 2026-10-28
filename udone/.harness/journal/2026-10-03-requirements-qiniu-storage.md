# 修订旅游 OMS 对象存储需求

> 状态更新（2026-10-03）：后续仓库整理已将 `TECH_SELECTION.md` 与 `ARCHITECTURE.md` 同步为七牛云目标、流程确认前不接入；Task 7 也已移除旧 Worker R2 依赖。以下“待单独同步”仅为当时记录，不代表当前状态。

## 今日完成

- 更新 canonical `Docs/REQUIREMENTS.md` 至 v2.1，记录 Cloudflare 部署 Web 前端与 API、Supabase 提供 PostgreSQL/Auth、七牛云为对象存储目标。
- 明确当前没有经确认、需要持久化的前端上传/下载流程；七牛集成延期，触发条件为产品需求明确上传/下载流程后另立任务。
- 同步修订首期范围、文件页面/API流程、事务步骤、容量门槛、实现约束、开发阶段与 UAT 中会让开发误以为对象存储已排期的内容。
- 未修改技术选型文档、平台计划或任何代码；保留原有 Task 7 未提交 WIP。

## 关键决策

- 对象存储目标依据用户本次明确决策记为七牛云；不推导套餐、凭证、API、SDK或完成状态。
- 暂不实现七牛集成；非持久化导入文件不自动触发对象存储集成。
- `Docs/REQUIREMENTS.md` 位于 `D:\Coding\ERP\udone` Git 根目录之外；`D:\Coding\ERP` 和 `D:\Coding\ERP\Docs` 均不是 Git 仓库。因此文档与本 journal 无法按当前仓库工作流组成用户要求的提交。本次没有暂存或提交 Task 7 WIP，也没有移动文档或另建仓库。

## 遇到的问题

- 文档不在可提交的 Git 根目录中；只读确认父目录和 Docs 子目录均没有 `.git`。无法创建包含 canonical 需求文档及本 journal 的 Git commit。
- `TECH_SELECTION.md` 仍保留先前 Cloudflare R2 技术选型。本次按用户要求未修改该其他文档，并在 REQUIREMENTS.md 标注其对象存储陈述待单独同步。

## 下一步计划

- 后续若要求将该文档提交，先明确是否将 `Docs/` 纳入 `udone` 仓库或指定文档仓库；当前不移动文件、不初始化新仓库。
- 产品需求明确需要持久化文件上传/下载流程时，再另立七牛云集成任务。
