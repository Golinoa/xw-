# 建立设计规范与讨论目录

## 今日完成

- 新建根级 `DESIGN.md`，说明页面样式规范入口和草稿/定稿边界。
- 新建 `.harness/Design-system/README.md`，作为已定稿设计规范目录索引。
- 新建 `.harness/design-drafts/README.md`，规定讨论提案暂存和定稿迁移方式。
- 更新 `AGENTS.md`，要求页面视觉工作读取根级设计入口，并遵守已定稿规范。

## 关键决策

- `.harness/DESIGN.md` 继续保留后端/架构设计原则；新建的根级 `DESIGN.md` 专门作为页面视觉规范入口。
- 目录目前只建立规范流程和索引，不预先决定颜色、字体、间距等视觉参数。

## 遇到的问题

- 无。

## 下一步计划

- 后续讨论的设计提案先放入 `.harness/design-drafts/`；只有用户确认定稿后才移入 `.harness/Design-system/`。
