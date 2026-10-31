import { describe, expect, it } from 'vitest';
import { OPS_SALES_USER, OPS_USER, call, expectStatus, signToken } from './harness';

/**
 * 导出任务的集成测试：真实 PostgREST + 真实 RPC + 真实对象存储替身。
 *
 * 这一层要证明三件单测与 pgTAP 各自只能证一半的事：
 *
 * 1. **202 之后真的会变成 succeeded。** 懒执行是挂在读请求上的，所以这条
 *    必须经由 HTTP 走一遍：`GET /exports/{id}` 触发认领 → 取数 → 签名上传 →
 *    完成。任何一环断了，前端看到的就是一个永远 `queued` 的任务。
 * 2. **签名出来的地址真的能打开。** 单测里 `downloadUrl` 是一个 stub 字符串，
 *    它能证明「给不给」，不能证明「给的对不对」。这里真的去 GET 一次，并
 *    检查文件以 UTF-8 BOM 开头——没有 BOM 的 CSV 在中文 Excel 里是乱码，
 *    而这一点在任何断言响应体的测试里都看不见。
 * 3. **`export.create` 与 `export.read` 是两条门。** `sales_ops` 有前者没有
 *    后者（契约 §4 的原始映射），所以它能发起、列不出来。
 */

const EXPORTS = '/api/v1/ops/exports';

const adminToken = signToken(OPS_USER);
const salesToken = signToken(OPS_SALES_USER);

interface ExportJob {
  id: string;
  exportNo: string;
  exportType: string;
  status: string;
  rowCount: number | null;
  requestedBy: { id: string; displayName: string };
  completedAt: string | null;
  expiresAt: string | null;
}

interface CreateBody {
  export: { id: string; exportNo: string; exportType: string; status: string };
}

interface DetailBody {
  export: ExportJob;
  downloadUrl: string | null;
  downloadExpiresAt: string | null;
  expiresAt: string | null;
}

interface ListBody {
  items: ExportJob[];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('POST /api/v1/ops/exports', () => {
  it('answers 202 with queued and points Location at the detail', async () => {
    const response = await call<CreateBody>(EXPORTS, {
      method: 'POST',
      token: adminToken,
      body: { exportType: 'customers', reason: '集成测试：建一份' },
    });

    expectStatus(response, 202);
    expect(response.body.export.status).toBe('queued');
    expect(response.body.export.exportNo).toMatch(/^EXP-\d{6}$/);
    expect(response.headers.get('Location')).toBe(`${EXPORTS}/${response.body.export.id}`);
  });

  it('rejects a request without an Idempotency-Key', async () => {
    const response = await call(EXPORTS, {
      method: 'POST',
      token: adminToken,
      omitIdempotencyKey: true,
      body: { exportType: 'customers', reason: '没有幂等键' },
    });

    expectStatus(response, 400);
  });

  it('rejects a request without a reason', async () => {
    const response = await call(EXPORTS, {
      method: 'POST',
      token: adminToken,
      body: { exportType: 'customers' },
    });

    expectStatus(response, 400);
  });

  it('rejects a whitespace-only reason', async () => {
    const response = await call(EXPORTS, {
      method: 'POST',
      token: adminToken,
      body: { exportType: 'customers', reason: '   ' },
    });

    expectStatus(response, 400);
  });

  it('rejects an unknown export type in zod, before reaching the database', async () => {
    const response = await call(EXPORTS, {
      method: 'POST',
      token: adminToken,
      body: { exportType: 'invoices', reason: '没做过的类型' },
    });

    expectStatus(response, 400);
  });

  it('lets sales_ops create an export', async () => {
    const response = await call<CreateBody>(EXPORTS, {
      method: 'POST',
      token: salesToken,
      body: { exportType: 'customers', reason: '商务自己导一份' },
    });

    expectStatus(response, 202);
  });
});

describe('GET /api/v1/ops/exports', () => {
  it('forbids sales_ops: export.read is a separate code from export.create', async () => {
    const response = await call(EXPORTS, { token: salesToken });

    // 契约 §4 给 sales_ops 的是 export.create 而**没有** export.read。这条
    // 记录的是现状：两个动作码分开是对的，「自己发起的也看不到」是缺口，见 C-124。
    expectStatus(response, 403);
  });

  it('lists jobs with the requester as an object', async () => {
    const response = await call<ListBody>(EXPORTS, { token: adminToken });

    expectStatus(response, 200);
    expect(Array.isArray(response.body.items)).toBe(true);
    for (const item of response.body.items) {
      expect(typeof item.requestedBy).toBe('object');
      expect(item.requestedBy.displayName.length).toBeGreaterThan(0);
    }
  });
});

describe('GET /api/v1/ops/exports/{exportId}', () => {
  it('runs the job on read, uploads the CSV and signs a working download URL', async () => {
    // 先造一行数据。集成库的夹具里没有客户（客户由各测试文件自己建），
    // 0 行的导出虽然合法，但那样就测不到「列名与值真的落进了文件」。
    const customer = await call('/api/v1/ops/customers', {
      method: 'POST',
      token: adminToken,
      body: { name: '导出集成客户', reason: '集成测试：给导出准备一行' },
    });
    expect(customer.status).toBeLessThan(400);

    const created = await call<CreateBody>(EXPORTS, {
      method: 'POST',
      token: adminToken,
      body: { exportType: 'customers', reason: '集成测试：跑完整条链路' },
    });
    expectStatus(created, 202);

    const id = created.body.export.id;
    let detail: DetailBody | null = null;

    // 每次详情请求推进**一条**待办，而队列里可能还有别的用例留下的任务。
    // 轮询而不是 sleep 一个固定时长：固定时长要么不够（假红）要么白等。
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await call<DetailBody>(`${EXPORTS}/${id}`, { token: adminToken });
      expectStatus(response, 200);
      detail = response.body;
      if (detail.export.status === 'succeeded' || detail.export.status === 'failed') break;
      await sleep(50);
    }

    expect(detail?.export.status).toBe('succeeded');
    expect(detail?.export.rowCount).toBeGreaterThanOrEqual(0);
    expect(detail?.export.expiresAt).not.toBeNull();
    expect(detail?.downloadUrl).toContain('/storage/v1/object/sign/ops-exports/');

    // 真的打开它。签名地址能签发不等于能下载：token 绑定对象、bucket 存在、
    // 网关把 `/storage/v1` 代理到了替身——三件事都只有这一跳能证明。
    const download = await fetch(detail!.downloadUrl!);
    expect(download.status).toBe(200);

    // 断字节而不是 `await download.text()`：WHATWG 的 UTF-8 解码会**剥掉**
    // 前导 BOM，于是 `text()` 拿到的字符串永远以 `\r` 开头——用字符串断 BOM
    // 会得到「文件没 BOM」的假结论。BOM 是给 Excel 看的，不是给解码器看的。
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    // 列名是**数据库列名**（`customer_no`），不是 DTO 的 `customerNo`。
    // 导出是从 SQL 层直接取行，转成 DTO 要为五个域各维护一份映射——那是第二
    // 真源，而且它一定会落后于 DTO 的改动。这条取舍记在 C-125。
    expect(csv).toContain('customer_no');
    expect(csv).toContain('导出集成客户');
  });

  it('answers 404 for an unknown id', async () => {
    const response = await call(`${EXPORTS}/00000000-0000-4000-8000-000000000000`, {
      token: adminToken,
    });

    expectStatus(response, 404);
  });
});
