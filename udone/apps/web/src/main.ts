import { createApp, h } from 'vue';
import Antd, { ConfigProvider } from 'ant-design-vue';
import 'ant-design-vue/dist/reset.css';
import { RouterView } from 'vue-router';
import { antDesignTheme, applyCssTokens } from './design-system/tokens';
import { createAppRouter } from './router';

applyCssTokens();

const app = createApp({
  render: () => h(ConfigProvider, { theme: antDesignTheme }, { default: () => h(RouterView) }),
});
app.use(Antd);
app.use(createAppRouter());
app.mount('#app');
