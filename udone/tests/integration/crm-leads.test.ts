import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface LeadList {
  items: Array<{
    id: string;
    name: string;
    stage: string;
    version: number;
    ownerId: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
}

const payload = {
  name: '集成测试线索',
  phone: '13900000161',
  source: '转介绍',
  destination: '桂林',
  departureCity: '广州',
  tripType: '跟团游',
  intentLevel: '高',
  expectedDate: '2026-12-25',
  budgetMin: 2000,
  budgetMax: 6000,
};

describe('CRM 线索走真实 PostgREST', () => {
  it('空列表可正常返回', async () => {
    const response = await call<LeadList>('/api/leads', { actor: 'admin' });
    expectStatus(response, 200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 15 });
  });

  it('建线索后出现在列表里', async () => {
    const created = await call<{ leadId: string }>('/api/leads', {
      method: 'POST',
      actor: 'admin',
      body: payload,
    });
    expectStatus(created, 200);

    const list = await call<LeadList>('/api/leads', { actor: 'admin' });
    expectStatus(list, 200);
    expect(list.body.items.some((item) => item.id === created.body.leadId)).toBe(true);
  });

  it('跟进需要正文，缺正文被拒', async () => {
    const list = await call<LeadList>('/api/leads', { actor: 'admin' });
    expectStatus(list, 200);
    if (!list.body.items.length) return;
    const lead = list.body.items[0]!;

    const response = await call('/api/leads/follow-up', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: lead.id, stage: 'contacting', detail: '' },
    });
    expectStatus(response, 400);
  });

  it('公海筛选只返回无负责人的线索', async () => {
    const response = await call<LeadList>('/api/leads', {
      actor: 'admin',
      query: { inPool: 'true' },
    });
    expectStatus(response, 200);
    expect(response.body.items.every((item) => item.ownerId === null)).toBe(true);
  });

  it('未成单的线索不能转客户', async () => {
    const created = await call<{ leadId: string }>('/api/leads', {
      method: 'POST',
      actor: 'admin',
      body: payload,
    });
    expectStatus(created, 200);

    const response = await call('/api/leads/convert', {
      method: 'POST',
      actor: 'admin',
      body: { leadId: created.body.leadId },
    });
    expectStatus(response, 409);
  });
});
