# 页面设计规范

页面布局、视觉样式、组件外观和设计 token 应遵守 `.harness/Design-system/` 中的定稿规范。**本文件是规范总索引和生效入口**；各规范正文为具体规则的权威来源，HTML 文件用于快速预览。

## 全局框架与首页

登录后的系统页面统一采用**全局顶栏 + 左侧菜单 + 右侧主工作区**。顶栏承载一级模块导航和全局操作，左侧菜单承载当前模块或项目的页面导航。首页主工作区采用项目管理仪表盘：上方摘要指标，中段主要图表与快捷操作，下方公告/通知、辅助统计和任务列表。窄屏行为遵循响应式布局规范。

## 定稿规范

| 规范 | 正文 | HTML 预览 | 范围 |
|---|---|---|---|
| 色彩 | [.harness/Design-system/color-system.md](.harness/Design-system/color-system.md) | [预览](.harness/Design-system/color-system-preview.html) | 品牌色、中性色、语意色、状态映射和对比度 |
| 布局与间距 | [.harness/Design-system/layout-spacing.md](.harness/Design-system/layout-spacing.md) | [预览](.harness/Design-system/layout-spacing-preview.html) | 间距 token、布局层级和圆角 |
| 字体与排版 | [.harness/Design-system/typography.md](.harness/Design-system/typography.md) | [预览](.harness/Design-system/typography-preview.html) | 字体栈、字号、行高、字重和可读性 |
| 组件 | [.harness/Design-system/component-guidelines.md](.harness/Design-system/component-guidelines.md) | [预览](.harness/Design-system/component-guidelines-preview.html) | Ant Design Vue 组件选用、操作状态、主题和可访问性 |
| 图标 | [.harness/Design-system/iconography.md](.harness/Design-system/iconography.md) | [预览](.harness/Design-system/iconography-preview.html) | 图标风格、尺寸、语义和可访问性 |
| 图表与数据可视化 | [.harness/Design-system/data-visualization.md](.harness/Design-system/data-visualization.md) | [预览](.harness/Design-system/data-visualization-preview.html) | 图表选型、色序、标签、状态和窄屏呈现 |
| 响应式布局 | [.harness/Design-system/responsive-layout.md](.harness/Design-system/responsive-layout.md) | [预览](.harness/Design-system/responsive-layout-preview.html) | 断点、导航、栅格、表格和窄屏操作 |
| 交互反馈与动效 | [.harness/Design-system/interaction-motion.md](.harness/Design-system/interaction-motion.md) | [预览](.harness/Design-system/interaction-motion-preview.html) | 交互状态、反馈层级、动效和减少动态效果 |

以上规范适用于有单 OMS Web 管理后台，自 2026-10-05 起生效。规则如有交叉，组合遵守各相关规范；具体组件的专属规则优先用于该组件，公共颜色、字体和间距仍遵循对应基础规范。

## 提案与生效边界

讨论中的提案暂存于 `.harness/design-drafts/`，不属于已生效规范。只有经用户确认或明确授权代理定稿后，才整理进 `.harness/Design-system/`，并同步更新本索引。
