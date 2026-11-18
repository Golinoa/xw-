import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

interface AuditEvent {
  id: string;
  actorName: string;
  action: string;
  entityType: string | null;
  summary: string;
  ipSummary: string | null;
}

interface AuditList {
  items: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

/** 用真实业务动作写一条审计（公司配置变更会写 audit_events），读当前版本避免冲突。 */
async function writeOneAudit() {
  const current = await call<{ version: number }>('/api/company-settings', { actor: 'admin' });
  expectStatus(current, 200);
  await call('/api/company-settings', {
    method: 'PATCH',
    actor: 'admin',
    body: {
      data: { theme: current.body.version % 2 === 0 ? 'dark' : 'light' },
      expectedVersion: current.body.version,
    },
  });
}

describe('审计日志走真实 PostgREST', () => {
  it('管理员能读到配置变更产生的审计', async () => {
    // 集成夹具本身不造审计数据。用真实业务动作（改公司配置）先写一条，
    // 这样测到的是「业务写 → 审计表 → 查询 API」的完整链路。
    await writeOneAudit();

    const response = await call<AuditList>('/api/audit-events', { actor: 'admin' });
    expectStatus(response, 200);
    expect(response.body.total).toBeGreaterThan(0);
    expect(response.body.items.some((item) => item.action === 'company_settings.update')).toBe(
      true,
    );
  });

  it('筛选动作后只返回匹配的行', async () => {
    await writeOneAudit();
    const all = await call<AuditList>('/api/audit-events', { actor: 'admin' });
    expectStatus(all, 200);
    const action = all.body.items[0]!.action;

    const filtered = await call<AuditList>('/api/audit-events', {
      actor: 'admin',
      query: { action },
    });
    expectStatus(filtered, 200);
    expect(filtered.body.items.every((item) => item.action === action)).toBe(true);
  });

  it('返回去重后的筛选项', async () => {
    await writeOneAudit();
    const response = await call<{ actions: string[]; entityTypes: string[] }>(
      '/api/audit-events/facets',
      { actor: 'admin' },
    );
    expectStatus(response, 200);
    expect(response.body.actions.length).toBeGreaterThan(0);
    expect(new Set(response.body.actions).size).toBe(response.body.actions.length);
  });

  it('没有 audit.read 的角色读不到审计', async () => {
    const response = await call('/api/audit-events', { actor: 'operator' });
    expectStatus(response, 403);
  });
});
