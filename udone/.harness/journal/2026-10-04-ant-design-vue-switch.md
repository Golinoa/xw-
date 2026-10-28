# 切换 Ant Design Vue

## 今日完成

- 将当前前端基线从 Element Plus 改为 Ant Design Vue，更新 `Docs/TECH_SELECTION.md`、`.harness/FRONTEND.md`、`Docs/REQUIREMENTS.md` 和活跃 MVP 计划。
- 为已完成的平台基础计划添加历史说明，保留当时使用 Element Plus 的实施记录。
- 更新 Web workspace 依赖和锁文件，移除 `element-plus`，添加 `ant-design-vue`；入口改用 Ant Design Vue 并加载 reset 样式。
- 将登录页、应用布局和工作台的原生控件替换为 Ant Design Vue 组件。
- 在技术选型中记录未来智能体功能评估 `ant-design-x-vue`，说明其为社区 Vue 实现且当前不加入依赖。

## 关键决策

- 当前后台使用 Ant Design Vue；智能体聊天界面延后到相关功能立项时评估和接入。
- pnpm 安装时发现 `core-js` 构建脚本未获允许。将 workspace 的 `allowBuilds.core-js` 明确设为 `false`，不执行该脚本。
- 保留此前的未提交改动；本次只编辑选型涉及的文档、Web 源码、依赖文件及本日志。

## 遇到的问题

- npm 镜像响应缓慢，首次添加依赖耗时较长；使用锁文件离线安装完成 workspace 链接。
- 首次构建发现布局根标签不匹配，修复后构建成功。构建仍报告主 JS chunk 约 1.76 MB，超过 Vite 默认 500 kB 提示阈值。
- 未运行测试套件；`ant-design-x-vue` 尚未加入依赖，也未验证与未来智能体 API 的适配。

## 下一步计划

- 后续页面按 Ant Design Vue 组件和样式约定实现。
- 智能体功能立项时，重新检查 `ant-design-x-vue` 的维护状态、许可、API 和服务端流式协议。
- 如需优化首屏包体积，再单独评估按需引入或代码拆分。
