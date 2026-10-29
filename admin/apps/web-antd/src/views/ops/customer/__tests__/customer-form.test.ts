import { flushPromises, mount } from '@vue/test-utils';

import { describe, expect, it } from 'vitest';

import CustomerForm from '../components/customer-form.vue';

/** antd 会在两个中文字之间插入空格，等待校验文案渲染完成。 */
async function settle() {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await flushPromises();
}

/** 取指定序号的输入框，缺失时直接抛错（避免非空断言）。 */
function inputAt(wrapper: ReturnType<typeof mount>, index: number) {
  const input = wrapper.findAll('input')[index];
  if (!input) {
    throw new Error(`未找到第 ${index} 个输入框`);
  }
  return input;
}

function submitButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper
    .findAll('button')
    .find((item) =>
      ['保存', '创建客户'].includes(item.text().replaceAll(/\s+/g, '')),
    );
  if (!button) {
    throw new Error('未找到提交按钮');
  }
  return button;
}

describe('customer-form 表单', () => {
  it('必填校验：名称为空时不 emit submit，并在字段下方给出原因', async () => {
    const wrapper = mount(CustomerForm);

    await submitButton(wrapper).trigger('click');
    await settle();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(wrapper.text()).toContain('请输入客户企业名称');
  });

  it('格式校验：统一社会信用代码不是 18 位时不提交', async () => {
    const wrapper = mount(CustomerForm);
    await inputAt(wrapper, 0).setValue('示例旅行社校验');
    await inputAt(wrapper, 1).setValue('abc');
    await submitButton(wrapper).trigger('click');
    await settle();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(wrapper.text()).toContain('统一社会信用代码为 18 位数字或大写字母');
  });

  it('地区码不是 6 位数字时不提交（GB/T 2260）', async () => {
    const wrapper = mount(CustomerForm);
    await inputAt(wrapper, 0).setValue('示例旅行社校验');
    await inputAt(wrapper, 2).setValue('31');
    await submitButton(wrapper).trigger('click');
    await settle();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(wrapper.text()).toContain('地区码为 6 位数字');
  });

  it('校验通过后提交去空格的值', async () => {
    const wrapper = mount(CustomerForm);
    await inputAt(wrapper, 0).setValue('  示例旅行社校验  ');
    await inputAt(wrapper, 2).setValue('310000');
    await submitButton(wrapper).trigger('click');
    await settle();

    const emitted = wrapper.emitted('submit');
    expect(emitted).toBeTruthy();
    expect(emitted?.[0]?.[0]).toMatchObject({
      name: '示例旅行社校验',
      regionCode: '310000',
    });
  });

  it('409 冲突：展示可读文案，且保留用户已填内容', async () => {
    const wrapper = mount(CustomerForm, {
      props: {
        initial: { name: '示例旅行社冲突' },
        serverMessage: '客户档案已被他人修改，请刷新后重试（请求 ID：req-1）',
      },
    });

    expect(wrapper.text()).toContain('客户档案已被他人修改');
    expect(wrapper.text()).toContain('已保留你填写的内容');
    expect((inputAt(wrapper, 0).element as HTMLInputElement).value).toBe(
      '示例旅行社冲突',
    );
  });
});
