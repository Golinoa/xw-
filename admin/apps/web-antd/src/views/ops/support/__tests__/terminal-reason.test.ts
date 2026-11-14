import type { TicketActionDef } from '#/api/ops/support/rules';

import { nextTick } from 'vue';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ticketStatusActions } from '#/api/ops/support/rules';

vi.stubEnv('VITE_GLOB_API_URL', '/api');
vi.stubEnv('VITE_OPS_API_PREFIX', '/v1/ops');

/**
 * 终态必填原因：**未填原因不发请求**（源码参考门 §4.1）。
 *
 * 请求只由详情页的 `@submit` 处理器发出，而弹窗只有在本地校验全部通过时才
 * `emit('submit')`。因此「没有 submit 事件」等价于「没有发请求」——
 * 这里断言的就是这条链路的前半段。
 */
function closeAction(): TicketActionDef {
  const action = ticketStatusActions('resolved').find(
    (item) => item.action === 'close',
  );
  if (!action) {
    throw new Error('契约 §3.8：resolved 必须允许 close');
  }
  return action;
}

function footerButton(label: string): HTMLButtonElement {
  const buttons = [
    ...document.body.querySelectorAll<HTMLButtonElement>(
      '.ant-modal-footer button',
    ),
  ];
  const button = buttons.find((item) =>
    (item.textContent ?? '').includes(label),
  );
  if (!button) {
    throw new Error(`找不到按钮：${label}`);
  }
  return button;
}

async function mountModal() {
  const { mount } = await import('@vue/test-utils');
  const { default: TicketTransitionModal } =
    await import('../components/ticket-transition-modal.vue');
  const wrapper = mount(TicketTransitionModal, {
    attachTo: document.body,
    props: {
      action: closeAction(),
      error: null,
      fromStatusLabel: '已解决',
      open: true,
      toStatusLabel: '已关闭',
    },
  });
  await vi.waitFor(() => {
    expect(document.body.querySelector('.ant-modal-footer')).not.toBeNull();
  });
  return wrapper;
}

async function typeReason(value: string) {
  const textarea = document.body.querySelector<HTMLTextAreaElement>(
    '.ant-modal-body textarea',
  );
  if (!textarea) {
    throw new Error('弹窗里没有原因输入框');
  }
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
  await nextTick();
}

async function confirmCheckbox() {
  const input = document.body.querySelector<HTMLInputElement>(
    '.ant-modal-body input[type="checkbox"]',
  );
  if (!input) {
    throw new Error('缺少二次确认勾选项（destructive-confirm）');
  }
  input.click();
  await nextTick();
}

describe('终态（关闭）必填原因', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('未填原因点「关闭工单」：不发请求，并提示必填', async () => {
    const wrapper = await mountModal();

    footerButton('关闭工单').click();
    await nextTick();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(document.body.textContent).toContain('请填写原因');
    wrapper.unmount();
  }, 20_000);

  it('填了原因但未勾选确认：仍不发请求（destructive-confirm）', async () => {
    const wrapper = await mountModal();

    await typeReason('客户确认问题已解决，本次售后结束');
    footerButton('关闭工单').click();
    await nextTick();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(document.body.textContent).toContain('请先勾选确认');
    wrapper.unmount();
  }, 20_000);

  it('原因 + 确认齐备后才上报，原因去掉首尾空白', async () => {
    const wrapper = await mountModal();

    await typeReason('  客户确认问题已解决，本次售后结束  ');
    await confirmCheckbox();
    footerButton('关闭工单').click();
    await nextTick();

    const emitted = wrapper.emitted('submit');
    expect(emitted).toHaveLength(1);
    expect(emitted?.[0]?.[0]).toMatchObject({
      reason: '客户确认问题已解决，本次售后结束',
    });
    wrapper.unmount();
  }, 20_000);

  it('「转入等待」必须填等待对象，未填不发请求', async () => {
    const { mount } = await import('@vue/test-utils');
    const { default: TicketTransitionModal } =
      await import('../components/ticket-transition-modal.vue');
    const waitAction = ticketStatusActions('in_progress').find(
      (item) => item.action === 'wait',
    );
    if (!waitAction) {
      throw new Error('契约 §3.8：in_progress 必须允许 wait');
    }

    const wrapper = mount(TicketTransitionModal, {
      attachTo: document.body,
      props: { action: waitAction, error: null, open: true },
    });
    await vi.waitFor(() => {
      expect(document.body.querySelector('.ant-modal-footer')).not.toBeNull();
    });

    footerButton('转入等待').click();
    await nextTick();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(document.body.textContent).toContain('等待对象');
    wrapper.unmount();
  }, 20_000);
});
