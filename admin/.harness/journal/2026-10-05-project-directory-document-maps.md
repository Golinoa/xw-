# 2026-10-05-project-directory-document-maps

## 今日完成
- 新增 `~admin/.harness/PROJECT_STRUCTURE.md`，区分当前文档基线与导入 Vben 后的目标结构，并写明跨项目文件所有权。
- 新增 `~admin/.harness/DOCUMENT_MAP.md`，集中导航产品/技术真源、Harness 规范、计划和 journal。
- 将两个地图链接加入 `AGENTS.md`、Harness README 与 Docs README。

## 关键决策
- 不把未导入的 Vben 目录写成当前事实；导入并锁定上游 commit 后按真实结构补全。
- `~admin` 只维护运营前端；API、Supabase migration、RLS 和数据库测试属于 `udone` 唯一真源。

## 遇到的问题
- 无。

## 下一步计划
- Task 1 导入 Vben 后，将计划结构与实际 workspace 比对并更新目录地图。
