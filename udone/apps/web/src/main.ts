import { createApp, h } from 'vue';
import { ConfigProvider } from 'ant-design-vue';
import 'ant-design-vue/dist/reset.css';
import { RouterView } from 'vue-router';
import { antdComponents } from './design-system/antd-registration';
import { antDesignTheme, applyCssTokens } from './design-system/tokens';
import { createAppRouter } from './router';

applyCssTokens();

const app = createApp({
  render: () => h(ConfigProvider, { theme: antDesignTheme }, { default: () => h(RouterView) }),
});
antdComponents.forEach((component) => app.use(component));
app.use(createAppRouter());
app.mount('#app');
