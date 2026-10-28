# 页面设计规范

本文件是运营后台的视觉规范索引和生效入口。界面沿用有单产品的既有设计系统，以 Vben Admin `web-antd` 的布局和 Ant Design Vue 组件为实现底座；未经确认不得另造一套色彩、间距或状态语义。

## 已定稿的共享视觉规则

以下规则由同级 `udone` 项目维护，作为两套有单 Web 后台共享的视觉真源：

| 规范 | 正文 | 适用内容 |
|---|---|---|
| 色彩 | [色彩规范](../udone/.harness/Design-system/color-system.md) | 品牌色、中性色、语意色、状态映射和对比度 |
| 布局与间距 | [布局与间距规范](../udone/.harness/Design-system/layout-spacing.md) | 页面层级、间距 token、圆角和密度 |
| 字体与排版 | [字体与排版规范](../udone/.harness/Design-system/typography.md) | 字体栈、字号、行高、字重和可读性 |
| 组件 | [组件规范](../udone/.harness/Design-system/component-guidelines.md) | Ant Design Vue 组件选型、主题、状态和可访问性 |
| 图标 | [图标规范](../udone/.harness/Design-system/iconography.md) | 图标风格、尺寸、语义和可访问性 |
| 图表 | [数据可视化规范](../udone/.harness/Design-system/data-visualization.md) | 图表、色序、标签和窄屏呈现 |
| 响应式 | [响应式布局规范](../udone/.harness/Design-system/responsive-layout.md) | 断点、导航、栅格、表格和窄屏操作 |
| 交互反馈 | [交互反馈与动效规范](../udone/.harness/Design-system/interaction-motion.md) | 反馈层级、状态变化、动效和减少动态效果 |

## 运营后台布局约束

- 登录后使用全局顶栏、左侧菜单和右侧主工作区；顶栏承载一级模块/全局操作，左侧菜单显示当前模块导航。
- 运营总览展示签约客户、临期合同/权益、应收和工单等指标；不得照搬旅行社业务仪表盘指标。
- Vben 默认主题需映射到共享色彩、字体、间距和语意状态 token。框架预置样式不自动成为本项目设计规则。
- 商业客户、金额、授权状态和租户同步状态必须清楚可读；危险操作须展示对象、影响和确认步骤。
- 管理表格优先保证列对齐、筛选、分页、空态、权限态和错误态；窄屏按响应式规则收敛导航与操作。

如共享视觉规则需要调整，先在 `udone` 的唯一真源中完成变更并同步其索引；本项目不复制一套平行设计文档。未来若两项目拆成独立交付仓库，再通过共同设计包或版本化规范迁移共享规则。
