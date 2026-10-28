# 2026-10-05-project-directory-document-maps

## 今日完成
- 将 Udone 项目目录与文件归属、Harness 文档索引地图放入 `.harness/`，并增加 Harness README 导航。
- 精简 Udone `AGENTS.md` 并将文档生命周期/地图规则转入 Harness 地图；为两个地图添加启动指引。

## 关键决策
- 项目目录地图记录已存在结构，并要求新增顶层目录或模块边界时同步更新；不预建不存在的业务目录。
- `~admin` 地图明确区分当前仅有文档的目录状态与未来导入 Vben 后的目标结构，导入后按锁定上游 commit 校正。
- 两个项目的 `.harness/DOCUMENT_MAP.md` 是各自 Harness 资料导航；领域真源仍归产品、技术、架构和视觉规范文档。

## 遇到的问题
- 无。

## 下一步计划
- Vben 导入完成后，依据实际 workspace 子目录更新 `~admin/.harness/PROJECT_STRUCTURE.md`。
