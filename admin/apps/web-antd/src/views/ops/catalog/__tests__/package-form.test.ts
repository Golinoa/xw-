import type { FeatureDefinition, ProductListItem } from '#/api/ops/catalog';

import { flushPromises, mount } from '@vue/test-utils';

import { describe, expect, it } from 'vitest';

import PackageForm from '../components/package-form.vue';
import ProductForm from '../components/product-form.vue';

/** antd 会在两个中文字之间插入空格，等待校验文案渲染完成。 */
async function settle() {
  await flushPromises();
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flushPromises();
}

const PRODUCTS: ProductListItem[] = [
  {
    code: 'OPS-SAAS-CORE',
    description: null,
    id: 'prd-0001',
    lifecycleStatus: 'active',
    name: '示例旅行社管理平台',
    packageCount: 1,
    salesModes: [
      { isEnabled: true, mode: 'saas' },
      { isEnabled: false, mode: 'private' },
    ],
    version: 1,
  },
];

const FEATURES: FeatureDefinition[] = [
  {
    description: null,
    displayName: '预订管理',
    featureKey: 'core.booking',
    isActive: true,
    unit: null,
    usageCount: 1,
    valueType: 'boolean',
  },
];

/** 取指定序号的输入框，缺失时直接抛错（避免非空断言）。 */
function inputAt(
  wrapper: ReturnType<typeof mount>,
  index: number,
  selector = 'input',
) {
  const input = wrapper.findAll(selector)[index];
  if (!input) {
    throw new Error(`未找到第 ${index} 个 ${selector}`);
  }
  return input;
}

function submitButton(wrapper: ReturnType<typeof mount>, text: string) {
  const button = wrapper
    .findAll('button')
    .find((item) => item.text().replaceAll(/\s+/g, '') === text);
  if (!button) {
    throw new Error(`未找到按钮：${text}`);
  }
  return button;
}

describe('product-form 校验', () => {
  it('编码与名称必填，且编码格式受限', async () => {
    const wrapper = mount(ProductForm);

    await submitButton(wrapper, '保存').trigger('click');
    await settle();

    expect(wrapper.text()).toContain('请输入产品编码');
    expect(wrapper.text()).toContain('请输入产品名称');

    const codeInput = inputAt(wrapper, 0);
    await codeInput.setValue('bad code');
    await submitButton(wrapper, '保存').trigger('click');
    await settle();
    expect(wrapper.text()).toContain('编码只能包含大写字母、数字与连字符');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('至少开放一种销售方式', async () => {
    const wrapper = mount(ProductForm);
    await inputAt(wrapper, 0).setValue('OPS-NEW');
    await inputAt(wrapper, 1).setValue('示例新产品');
    // 关闭默认开启的 SaaS 勾选
    await inputAt(wrapper, 0, 'input[type="checkbox"]').setValue(false);
    await submitButton(wrapper, '保存').trigger('click');
    await settle();

    expect(wrapper.text()).toContain('至少开放一种销售方式');
    expect(wrapper.emitted('submit')).toBeUndefined();
  });

  it('校验通过后按销售方式构造提交值', async () => {
    const wrapper = mount(ProductForm);
    await inputAt(wrapper, 0).setValue('OPS-NEW');
    await inputAt(wrapper, 1).setValue(' 示例新产品 ');
    await submitButton(wrapper, '保存').trigger('click');
    await settle();

    expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({
      code: 'OPS-NEW',
      name: '示例新产品',
      saasEnabled: true,
    });
  });

  it('服务端 409 提示保留输入', () => {
    const wrapper = mount(ProductForm, {
      props: {
        initial: { code: 'OPS-SAAS-CORE', name: '示例旅行社管理平台' },
        serverMessage: '数据已变更，请刷新后重试',
      },
    });

    expect(wrapper.text()).toContain('数据已变更，请刷新后重试');
    expect((inputAt(wrapper, 0).element as HTMLInputElement).value).toBe(
      'OPS-SAAS-CORE',
    );
  });
});

describe('package-form 校验', () => {
  it('未选产品、未填名称与挂牌价时不提交', async () => {
    const wrapper = mount(PackageForm, {
      props: { features: FEATURES, products: PRODUCTS },
    });

    await submitButton(wrapper, '创建套餐').trigger('click');
    await settle();

    expect(wrapper.emitted('submit')).toBeUndefined();
    expect(wrapper.text()).toContain('请选择产品');
    expect(wrapper.text()).toContain('请输入内部名称');
    expect(wrapper.text()).toContain('请输入客户可见名称');
    expect(wrapper.text()).toContain('请输入挂牌价');
  });

  it('产品未开放销售方式时给出明确阻断说明', () => {
    const wrapper = mount(PackageForm, {
      props: {
        features: FEATURES,
        products: [
          {
            ...(PRODUCTS[0] as ProductListItem),
            salesModes: [
              { isEnabled: false, mode: 'saas' },
              { isEnabled: false, mode: 'private' },
            ],
          },
        ],
      },
    });

    expect(wrapper.text()).toContain('该产品未开放任何销售方式');
  });
});
