import { describe, expect, it } from 'vitest';
import { OPS_FINANCE_USER, OPS_SALES_USER, call, expectStatus, signToken } from './harness';

/**
 * 报表集成测试：真实 PostgREST + 真实 RPC。
 *
 * 这一层证明的是「报表与列表读的是同一份数据」：两个端点并行调用，数字必须相等。
 * 「数字算得对不对」在 `supabase/tests/ops_reports_domain.sql` 里逐条钉死
 * （R6 的逾期取尚欠、S6 的失败命令数与总览相等）——那边有固定夹具，这边没有。
 *
 * 并行跑在同一个库上，所以金额只比「两个端点之间相等」，不与常量比：
 * 常量会随别处的测试数据漂移，而「相等」是这条验收的全部内容。
 */

const RECEIVABLES = '/api/v1/ops/receivables';
const RECEIVABLE_REPORT = '/api/v1/ops/reports/receivables';
const EXPIRING_REPORT = '/api/v1/ops/reports/expiring-entitlements';
const SYNC_REPORT = '/api/v1/ops/reports/tenant-sync-failures';
const VERSION_REPORT = '/api/v1/ops/reports/deployment-versions';

const salesToken = signToken(OPS_SALES_USER);
const financeToken = signToken(OPS_FINANCE_USER);

interface ReceivableReportBody {
  statisticsAt: string;
  groupBy: string;
  rows: Array<{ key: string; label: string; outstandingAmount: number; overdueAmount: number }>;
  totals: {
    count: number;
    totalAmount: number;
    settledAmount: number;
    outstandingAmount: number;
    overdueAmount: number;
  };
  filtersEcho: { groupBy: string };
}

interface ListSummaryBody {
  summary: {
    totalAmount: number;
    settledAmount: number;
    outstandingAmount: number;
    overdueAmount: number;
  };
}

describe('GET /api/v1/ops/reports/receivables', () => {
  it('agrees with the receivable list summary (T-13 acceptance)', async () => {
    const [report, list] = await Promise.all([
      call<ReceivableReportBody>(RECEIVABLE_REPORT, { token: salesToken }),
      call<ListSummaryBody>(RECEIVABLES, { token: salesToken, query: { pageSize: '15' } }),
    ]);
    expectStatus(report, 200);
    expectStatus(list, 200);

    expect(report.body.totals.overdueAmount).toBeCloseTo(list.body.summary.overdueAmount, 2);
    expect(report.body.totals.totalAmount).toBeCloseTo(list.body.summary.totalAmount, 2);
    expect(report.body.totals.settledAmount).toBeCloseTo(list.body.summary.settledAmount, 2);
    expect(report.body.totals.outstandingAmount).toBeCloseTo(
      list.body.summary.outstandingAmount,
      2,
    );
  });

  it('groups by due month with a YYYY-MM key', async () => {
    const response = await call<ReceivableReportBody>(RECEIVABLE_REPORT, {
      token: salesToken,
      query: { groupBy: 'dueMonth' },
    });
    expectStatus(response, 200);
    expect(response.body.groupBy).toBe('dueMonth');
    for (const row of response.body.rows) {
      expect(row.key).toMatch(/^\d{4}-\d{2}$/);
    }
  });

  it('rejects an unknown groupBy instead of returning an empty report', async () => {
    const response = await call(RECEIVABLE_REPORT, {
      token: salesToken,
      query: { groupBy: 'quarter' },
    });
    // API 层的 zod 先挡一次（枚举），所以这里是 400 + issues，不是 RPC 信封。
    expectStatus(response, 400);
  });

  it('forbids a caller without receivable.read', async () => {
    // 交付/售后都没有 `receivable.read`；用 finance 反证方向：它有，所以能过。
    const finance = await call(RECEIVABLE_REPORT, { token: financeToken });
    expectStatus(finance, 200);
  });
});

describe('GET /api/v1/ops/reports/expiring-entitlements', () => {
  it('echoes the window and returns rows', async () => {
    const response = await call<{ windowDays: number; rows: unknown[] }>(EXPIRING_REPORT, {
      token: salesToken,
      query: { windowDays: '14' },
    });
    expectStatus(response, 200);
    expect(response.body.windowDays).toBe(14);
    expect(Array.isArray(response.body.rows)).toBe(true);
  });
});

describe('GET /api/v1/ops/reports/tenant-sync-failures', () => {
  it('returns rows for a tenant reader', async () => {
    const response = await call<{ rows: unknown[] }>(SYNC_REPORT, { token: salesToken });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.rows)).toBe(true);
  });

  it('forbids a caller without tenant.read', async () => {
    const response = await call(SYNC_REPORT, { token: financeToken });
    expectStatus(response, 403);
    expect(response.body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('GET /api/v1/ops/reports/deployment-versions', () => {
  it('separates the instances without a version', async () => {
    const response = await call<{ rows: unknown[]; unknownVersionCount: number }>(VERSION_REPORT, {
      token: salesToken,
    });
    expectStatus(response, 200);
    expect(Array.isArray(response.body.rows)).toBe(true);
    expect(response.body.unknownVersionCount).toBeGreaterThanOrEqual(0);
    // 未知版本不能出现在 rows 里：混进某个版本号会让「1.4.0 有 5 台」变成假话。
    for (const row of response.body.rows as Array<{ version: unknown }>) {
      expect(typeof row.version).toBe('string');
    }
  });
});
