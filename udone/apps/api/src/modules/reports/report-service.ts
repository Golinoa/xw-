import type { ReportResponse, SupplierReportResponse } from '@erp/contracts';
import type { ApiEnvironment } from '../../middleware/auth';
import { createRestClient } from '../../lib/rest-client';

type SupplierRow = {
  supplier_id: string;
  supplier_name: string;
  order_count: number;
  payable_amount: number;
  confirmed_amount: number;
};

export interface ReportRepository {
  tenant(
    input: {
      from: string;
      to: string;
      includeCancelled: boolean;
    },
    organizationId: string,
  ): Promise<ReportResponse>;
  suppliers(
    input: {
      from: string;
      to: string;
      includeCancelled: boolean;
    },
    organizationId: string,
  ): Promise<SupplierReportResponse>;
}

export function reportRepository(
  environment: ApiEnvironment['Bindings'],
  token: string,
): ReportRepository {
  const client = createRestClient(environment, token);
  const body = (input: { from: string; to: string; includeCancelled: boolean }) => ({
    requested_from: input.from,
    requested_to: input.to,
    requested_include_cancelled: input.includeCancelled,
  });

  return {
    async tenant(input, organizationId) {
      // 函数返回 jsonb 标量，PostgREST 给的是对象而不是数组。
      const payload = await client.rest<ReportResponse | ReportResponse[]>('rpc/tenant_report', {
        method: 'POST',
        organizationId,
        body: body(input),
      });
      return Array.isArray(payload) ? payload[0]! : payload;
    },

    async suppliers(input, organizationId) {
      const rows = await client.rest<SupplierRow[]>('rpc/tenant_supplier_report', {
        method: 'POST',
        organizationId,
        body: body(input),
      });
      return {
        items: rows.map((row) => ({
          supplierId: row.supplier_id,
          supplierName: row.supplier_name,
          orderCount: row.order_count,
          payableAmount: row.payable_amount,
          confirmedAmount: row.confirmed_amount,
        })),
      };
    },
  };
}
