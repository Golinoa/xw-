import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface SupplierBody {
  supplier: {
    id: string;
    name: string;
    type: string;
    contactName?: string;
    phone?: string;
    settlement: string;
    isActive: boolean;
    remark?: string;
  };
}

interface SupplierListBody {
  items: SupplierBody['supplier'][];
  total: number;
}

async function createSupplier(name: string, extra: Record<string, unknown> = {}) {
  const response = await call<SupplierBody>('/api/suppliers', {
    method: 'POST',
    actor: 'admin',
    body: {
      name,
      type: 'hotel',
      settlement: 'monthly',
      contactName: '王经理',
      phone: '13800138000',
      ...extra,
    },
  });
  expectStatus(response, 201);
  return response.body.supplier;
}

describe('供应商编辑与停用走真实 PostgREST', () => {
  it('改名只改名字，联系人与电话保持原样', async () => {
    const created = await createSupplier(`改名测试 ${Date.now()}`);

    const patched = await call<SupplierBody>(`/api/suppliers/${created.id}`, {
      method: 'PATCH',
      actor: 'admin',
      body: { name: `${created.name}-改` },
    });
    expectStatus(patched, 200);
    expect(patched.body.supplier.name).toBe(`${created.name}-改`);
    // 这是最容易写错的一处：PATCH 用 `?? null` 兜底会把没传的字段清空
    expect(patched.body.supplier.contactName).toBe('王经理');
    expect(patched.body.supplier.phone).toBe('13800138000');
    expect(patched.body.supplier.settlement).toBe('monthly');
  });

  it('停用后默认列表不再出现，但带 activeOnly=false 仍可查到', async () => {
    const created = await createSupplier(`停用测试 ${Date.now()}`);

    const disabled = await call<SupplierBody>(`/api/suppliers/${created.id}`, {
      method: 'PATCH',
      actor: 'admin',
      body: { isActive: false },
    });
    expectStatus(disabled, 200);
    expect(disabled.body.supplier.isActive).toBe(false);

    const active = await call<SupplierListBody>('/api/suppliers', {
      actor: 'admin',
      query: { keyword: created.name, pageSize: '15' },
    });
    expectStatus(active, 200);
    expect(active.body.items.map((item) => item.id)).not.toContain(created.id);

    const all = await call<SupplierListBody>('/api/suppliers', {
      actor: 'admin',
      query: { keyword: created.name, activeOnly: 'false', pageSize: '15' },
    });
    expectStatus(all, 200);
    expect(all.body.items.map((item) => item.id)).toContain(created.id);
  });

  it('清空联系人要显式发 null', async () => {
    const created = await createSupplier(`清空测试 ${Date.now()}`);

    const cleared = await call<SupplierBody>(`/api/suppliers/${created.id}`, {
      method: 'PATCH',
      actor: 'admin',
      body: { contactName: null, phone: null },
    });
    expectStatus(cleared, 200);
    expect(cleared.body.supplier.contactName ?? null).toBeNull();
    expect(cleared.body.supplier.phone ?? null).toBeNull();
  });

  it('没有 supplier.write 的角色改不动供应商', async () => {
    const created = await createSupplier(`权限测试 ${Date.now()}`);
    const denied = await call(`/api/suppliers/${created.id}`, {
      method: 'PATCH',
      actor: 'finance',
      body: { name: '偷偷改' },
    });
    // 财务只有 supplier.read：改供应商是采购/计调的事
    expectStatus(denied, 403);
  });

  it('未被引用的供应商可以删除', async () => {
    const created = await createSupplier(`删除测试 ${Date.now()}`);
    const deleted = await call<{ deletedSupplierId: string }>(`/api/suppliers/${created.id}`, {
      method: 'DELETE',
      actor: 'admin',
    });
    expectStatus(deleted, 200);
    expect(deleted.body.deletedSupplierId).toBe(created.id);

    const after = await call<SupplierListBody>('/api/suppliers', {
      actor: 'admin',
      query: { keyword: created.name, activeOnly: 'false' },
    });
    expectStatus(after, 200);
    expect(after.body.items.map((item) => item.id)).not.toContain(created.id);
  });
});
