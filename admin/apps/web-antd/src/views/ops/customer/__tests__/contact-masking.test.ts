import type { CustomerContact } from '#/api/ops/customer';

import { mount } from '@vue/test-utils';

import { describe, expect, it } from 'vitest';

import ContactTable from '../components/contact-table.vue';

const CONTACT: CustomerContact = {
  email: 'contact.a@example.invalid',
  emailMasked: 'c***@example.invalid',
  id: 'ct-0001',
  isPrimary: true,
  jobTitle: '信息部经理',
  name: '示例联系人甲',
  phone: '13800001234',
  phoneMasked: '138****1234',
  usageScene: '日常对接',
  version: 1,
};

describe('contact-table 联系方式掩码', () => {
  it('无 customer.sensitive.read 时只显示掩码，不泄露原值', () => {
    const wrapper = mount(ContactTable, {
      props: { canReadSensitive: false, contacts: [CONTACT] },
    });

    const text = wrapper.text();
    expect(text).toContain('138****1234');
    expect(text).toContain('c***@example.invalid');
    expect(text).not.toContain('13800001234');
    expect(text).not.toContain('contact.a@example.invalid');
    expect(text).toContain('需查看原值请申请 customer.sensitive.read 权限');
  });

  it('具备 customer.sensitive.read 且后端下发原值时展示原值', () => {
    const wrapper = mount(ContactTable, {
      props: { canReadSensitive: true, contacts: [CONTACT] },
    });

    const text = wrapper.text();
    expect(text).toContain('13800001234');
    expect(text).toContain('contact.a@example.invalid');
    expect(text).toContain('联系方式显示后端下发的原值');
  });

  it('无 customer.write 时不渲染写操作入口（只读）', () => {
    const wrapper = mount(ContactTable, {
      props: { canReadSensitive: false, canWrite: false, contacts: [CONTACT] },
    });

    expect(wrapper.text()).toContain('只读');
    expect(wrapper.text()).not.toContain('新增联系人');
  });

  it('有 customer.write 时渲染新增/编辑/删除入口并透传事件', async () => {
    const wrapper = mount(ContactTable, {
      props: { canReadSensitive: false, canWrite: true, contacts: [CONTACT] },
    });

    expect(wrapper.text()).toContain('新增联系人');

    const editButton = wrapper
      .findAll('button')
      .find((item) => item.text() === '编辑');
    if (!editButton) {
      throw new Error('未找到编辑按钮');
    }
    await editButton.trigger('click');

    expect(wrapper.emitted('edit')?.[0]?.[0]).toMatchObject({ id: 'ct-0001' });
  });
});
