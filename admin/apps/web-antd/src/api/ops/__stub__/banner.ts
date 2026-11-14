/**
 * 开发态契约桩的可见提示。
 *
 * 为什么不是页面组件：`src/views/**`、`src/layouts/**` 属于其他负责人的文件边界，
 * 桩又必须"在 UI 上可见、绝不冒充真实集成"。因此桩在首次被调用时挂一个固定的顶部条，
 * 只要桩启用就必然出现，无法被页面遗漏。
 *
 * 生产构建中 `VITE_OPS_MOCK=false` 会连同整个 `__stub__` 目录一起被 tree-shake，
 * 这个条幅不会出现在产物里。
 */

const BANNER_ID = 'ops-dev-stub-banner';

export function mountStubBanner(): void {
  if (typeof document === 'undefined' || !import.meta.env.DEV) {
    return;
  }
  if (document.querySelector(`#${BANNER_ID}`)) {
    return;
  }
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.setAttribute('role', 'status');
  banner.textContent =
    '开发态契约桩 · 数据全部虚构 · 后端未接入（关闭方式：VITE_OPS_MOCK=false）';
  banner.style.cssText = [
    'position:fixed',
    'top:0',
    'left:0',
    'right:0',
    'z-index:2147483647',
    'padding:4px 12px',
    'font-size:12px',
    'line-height:18px',
    'text-align:center',
    'color:#7a4b00',
    'background:#fff3cd',
    'border-bottom:1px solid #f0c36d',
  ].join(';');
  document.body.prepend(banner);
}

export function unmountStubBanner(): void {
  if (typeof document === 'undefined') {
    return;
  }
  document.querySelector(`#${BANNER_ID}`)?.remove();
}
