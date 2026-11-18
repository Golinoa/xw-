import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface ReportResponse {
  dateField: string;
  from: string;
  to: string;
  includeCancelled: boolean;
  overview: {
    orderCount: number;
    receivableTotal: number;
    payableTotal: number;
    profit: number;
  };
  finance: {
    confirmedIn: number;
    pendingIn: number;
    confirmedOut: number;
    pendingOut: number;
  };
  byStatus: Record<string, number>;
}

describe('报表走真实 PostgREST', () => {
  const range = { from: '2026-11-01', to: '2026-11-30' };

  it('总览报告返回统一口径字段', async () => {
    const response = await call<ReportResponse>('/api/reports/tenant', {
      actor: 'admin',
      query: range,
    });
    expectStatus(response, 200);
    expect(response.body.dateField).toBe('createdAt');
    expect(response.body.overview).toHaveProperty('orderCount');
    expect(response.body.finance).toHaveProperty('pendingIn');
  });

  it('取消订单默认排除，显式包含时返回另一个结果标记', async () => {
    const excluded = await call<ReportResponse>('/api/reports/tenant', {
      actor: 'admin',
      query: range,
    });
    expectStatus(excluded, 200);
    expect(excluded.body.includeCancelled).toBe(false);

    const included = await call<ReportResponse>('/api/reports/tenant', {
      actor: 'admin',
      query: { ...range, includeCancelled: 'true' },
    });
    expectStatus(included, 200);
    expect(included.body.includeCancelled).toBe(true);
  });

  it('供应商统计与总览使用同一日期范围', async () => {
    const response = await call<{ items: Array<{ supplierId: string; payableAmount: number }> }>(
      '/api/reports/suppliers',
      { actor: 'admin', query: range },
    );
    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
  });

  it('日期格式错误被拒', async () => {
    const response = await call('/api/reports/tenant', {
      actor: 'admin',
      query: { from: '2026/11/01', to: '2026-11-30' },
    });
    expectStatus(response, 400);
  });

  it('所有租户成员都能读报表（order.read 是全角色基础权限）', async () => {
    const response = await call<ReportResponse>('/api/reports/tenant', {
      actor: 'operator',
      query: range,
    });
    expectStatus(response, 200);
    expect(response.body.dateField).toBe('createdAt');
  });
});
