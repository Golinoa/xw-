import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';

import { afterEach, describe, expect, it } from 'vitest';

import HighRiskConfirm from '../components/high-risk-confirm.vue';

/** 取必须存在的元素，缺失时直接抛错（避免非空断言）。 */
function mustQuery<T extends Element>(selector: string): T {
  const element = document.body.querySelector<T>(selector);
  if (!element) {
    throw new Error(`未找到元素：${selector}`);
  }
  return element;
}

function mountConfirm(extra: Record<string, unknown> = {}) {
  return mount(HighRiskConfirm, {
    attachTo: document.body,
    props: {
      actionLabel: '确认生效',
      errorMessage: null,
      impactItems: [
        { label: '合同金额', value: '¥396,000.00' },
        { label: '条目数量', value: '2 条' },
      ],
      open: true,
      permissionLabel: 'contract.approve',
      title: '确认生效 · HT-2026-000045',
      ...extra,
    },
  });
}

async function typeReason(value: string) {
  const textarea = mustQuery<HTMLTextAreaElement>('[data-testid="hrc-reason"]');
  textarea.value = value;
  textarea.dispatchEvent(new Event('input'));
  await nextTick();
  await flushPromises();
}

async function clickAck() {
  // antd-vue 把透传属性挂到真正的 <input class="ant-checkbox-input"> 上
  const checkbox = mustQuery<HTMLInputElement>('[data-testid="hrc-ack"]');
  checkbox.click();
  await nextTick();
  await flushPromises();
}

async function clickConfirm() {
  const button = mustQuery<HTMLButtonElement>('[data-testid="hrc-confirm"]');
  button.click();
  await nextTick();
  await flushPromises();
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('高风险动作二次确认（contract.approve）', () => {
  it('展示影响摘要与所需动作码，且不是一次点击直接生效', async () => {
    const wrapper = mountConfirm();

    expect(document.body.textContent).toContain('风险');
    expect(document.body.textContent).toContain('contract.approve');
    expect(document.body.textContent).toContain('¥396,000.00');
    expect(document.body.textContent).toContain('我已确认上述影响摘要');

    await clickConfirm();

    // 未填原因、未勾选确认 → 不发出 confirm（等价于不发请求）
    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(document.body.textContent).toContain('请填写操作原因');
  });

  it('只填原因但未勾选确认时仍不提交', async () => {
    const wrapper = mountConfirm();

    await typeReason('客户已完成用印，按合同约定生效');
    await clickConfirm();

    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(document.body.textContent).toContain('请先确认已阅读影响摘要');
  });

  it('只勾选确认但未填原因时仍不提交', async () => {
    const wrapper = mountConfirm();

    await clickAck();
    await clickConfirm();

    expect(wrapper.emitted('confirm')).toBeUndefined();
    expect(document.body.textContent).toContain('请填写操作原因');
  });

  it('原因 + 勾选确认后才发出 confirm，并把原因回传给调用方', async () => {
    const wrapper = mountConfirm();

    await typeReason('客户已完成用印，按合同约定生效');
    await clickAck();
    await clickConfirm();

    expect(wrapper.emitted('confirm')?.[0]?.[0]).toBe(
      '客户已完成用印，按合同约定生效',
    );
  });

  it('中风险动作（提交/撤回）原因选填，但仍需勾选确认', async () => {
    const wrapper = mountConfirm({
      actionLabel: '提交审核',
      permissionLabel: 'contract.write',
      reasonRequired: false,
    });

    await clickConfirm();
    expect(wrapper.emitted('confirm')).toBeUndefined();

    await clickAck();
    await clickConfirm();
    expect(wrapper.emitted('confirm')?.[0]?.[0]).toBe('');
  });

  it('服务端 409 原因展示在弹窗内，输入不丢失', async () => {
    const wrapper = mountConfirm({
      errorMessage: '当前状态不允许此操作（请求 ID：req-9）',
    });

    expect(document.body.textContent).toContain('当前状态不允许此操作');
    expect(document.body.textContent).toContain('req-9');

    // 失败后弹窗不关闭，已填原因仍在
    await typeReason('客户已完成用印，按合同约定生效');
    expect(
      mustQuery<HTMLTextAreaElement>('[data-testid="hrc-reason"]').value,
    ).toBe('客户已完成用印，按合同约定生效');
    expect(wrapper.emitted('confirm')).toBeUndefined();
  });
});
