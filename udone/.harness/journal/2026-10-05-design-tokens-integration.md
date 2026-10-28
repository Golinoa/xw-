# Design-system token 接入

## 今日完成

- 新建前端统一 token 来源，将色彩、间距、字体和圆角映射为 CSS 变量与 Ant Design Vue 主题。
- 在应用根部使用 ConfigProvider 注入主题。
- 将顶栏、登录页和工作台现有的颜色、字号、间距、边框、圆角硬编码替换为规范 token。

## 关键决策

- Ant Design Vue 使用品牌操作蓝 600、语意色、4px 圆角、14px 正文和参考间距值；控件高度保留库默认值。
- CSS 变量和 ConfigProvider 共用 `apps/web/src/design-system/tokens.ts` 的单一 token 来源。
- 仅迁移当前已使用的三个页面区域，未扩展到其他页面或业务组件。

## 遇到的问题

- 项目原有页面局部样式与新规范不一致；本次只清理涉及页面的样式。

## 下一步计划

- 后续新页面直接使用主题 token；触及其他既有页面时再逐步迁移其局部硬编码。
