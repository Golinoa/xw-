import { describe, expect, it } from 'vitest';
import { call, expectStatus } from './harness';

/**
 * 游客名单，跑在真实 PostgREST 上。
 *
 * 这一层要证明的是 pgTAP 与单测都证明不了的三件事：
 * 1. 规范化去重在真实写入路径上生效（`23505` 被 PostgREST 映射成 409，而不是 500）；
 * 2. `rpc/import_tourists` 的参数名、返回列名与 JSON 形状都是对的；
 * 3. 覆盖模式的「整批原子」在 HTTP 层也成立：批内重复时老名单必须原样还在。
 *
 * 每次运行都新建订单：名单是订单内的数据，重复运行不会互相干扰。
 */

const suffix = Math.random().toString(36).slice(2, 8);

interface CustomerCreated {
  customer: { id: string };
}

interface OrderCreated {
  order: { id: string };
}

interface TouristBody {
  id: string;
  name: string;
  documentType?: string;
  documentNumber?: string;
  documentNumberMasked?: string;
  personType: string;
  gender: string;
}

interface RosterBody {
  roster: {
    items: TouristBody[];
    total: number;
    adultCount: number;
    childCount: number;
    declaredAdultCount: number;
    declaredChildCount: number;
  };
}

interface PreviewBody {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  errors: Array<{ line: number; message: string }>;
  summary: { personCount: number };
}

const HEADER = '姓名,手机,证件类型,证件号,成人/儿童,年龄,性别,备注';

function csv(...rows: string[]): string {
  return `\uFEFF${[HEADER, ...rows].join('\r\n')}\r\n`;
}

describe('游客名单走真实 PostgREST', () => {
  let orderId = '';
  // 随机号码：集成库在多次运行之间可能被复用，写死号码会在第二次运行时撞唯一索引。
  const idNumber = `11010119900101${String(Math.floor(Math.random() * 9000) + 1000)}`;

  it('创建客户与订单', async () => {
    const customer = await call<CustomerCreated>('/api/customers', {
      method: 'POST',
      body: { name: `游客集成客户-${suffix}`, phone: '13800009901' },
    });
    expectStatus(customer, 201);

    const order = await call<OrderCreated>('/api/orders', {
      method: 'POST',
      body: {
        customerId: customer.body.customer.id,
        orderType: 'booking',
        routeName: '游客集成线路',
        departureDate: '2027-05-01',
        returnDate: '2027-05-04',
        adultCount: 1,
        childCount: 0,
        receivables: [{ name: '团费', amount: 2400 }],
        payables: [],
      },
    });
    expectStatus(order, 201);
    orderId = order.body.order.id;
  });

  it('手工添加游客，返回未掩码的证件号（管理员有敏感权限）', async () => {
    const response = await call<{ tourist: TouristBody }>(`/api/orders/${orderId}/tourists`, {
      method: 'POST',
      body: {
        name: '张一',
        personType: 'adult',
        documentType: 'id_card',
        documentNumber: `${idNumber.slice(0, 6)}-${idNumber.slice(6, 14)}-${idNumber.slice(14)}`,
        age: 36,
        gender: 'male',
      },
    });

    expectStatus(response, 201);
    expect(response.body.tourist.documentNumber).toBeDefined();
  });

  it('同一证件换个写法就是重复，返回 409 而不是 500', async () => {
    const response = await call<{ code: string }>(`/api/orders/${orderId}/tourists`, {
      method: 'POST',
      body: {
        name: '张一重复',
        personType: 'adult',
        documentType: 'id_card',
        documentNumber: idNumber,
      },
    });

    expectStatus(response, 409);
    expect(response.body.code).toBe('TOURIST_DOCUMENT_CONFLICT');
  });

  it('名单带出订单申报人数，供前端算差额', async () => {
    const response = await call<RosterBody>(`/api/orders/${orderId}/tourists`);

    expectStatus(response, 200);
    expect(response.body.roster).toMatchObject({
      total: 1,
      adultCount: 1,
      childCount: 0,
      declaredAdultCount: 1,
      declaredChildCount: 0,
    });
  });

  it('预览只解析不落库', async () => {
    const preview = await call<PreviewBody>(`/api/orders/${orderId}/tourists/import-preview`, {
      method: 'POST',
      body: { csv: csv('李二,13900000102,护照,P' + suffix + ',儿童,8,女,'), mode: 'append' },
    });

    expectStatus(preview, 200);
    expect(preview.body).toMatchObject({ totalRows: 1, validRows: 1, invalidRows: 0 });
    expect(preview.body.errors).toEqual([]);

    const roster = await call<RosterBody>(`/api/orders/${orderId}/tourists`);
    expect(roster.body.roster.total).toBe(1);
  });

  it('追加导入两人，返回写入条数', async () => {
    const response = await call<{ inserted: number; deleted: number }>(
      `/api/orders/${orderId}/tourists/import`,
      {
        method: 'POST',
        body: {
          csv: csv(
            `李二,13900000102,护照,P${suffix},儿童,8,女,`,
            `王三,13900000103,港澳通行证,H${suffix},成人,41,男,`,
          ),
          mode: 'append',
        },
      },
    );

    expectStatus(response, 200);
    expect(response.body).toEqual({ inserted: 2, deleted: 0 });

    const roster = await call<RosterBody>(`/api/orders/${orderId}/tourists`);
    expect(roster.body.roster.total).toBe(3);
    expect(roster.body.roster.childCount).toBe(1);
  });

  it('批内重复整批拒绝，名单不变', async () => {
    const response = await call<{ code: string; details: { errors: unknown[] } }>(
      `/api/orders/${orderId}/tourists/import`,
      {
        method: 'POST',
        body: {
          csv: csv(
            `重复甲,,身份证,${idNumber},成人,36,男,`,
            `重复乙,,身份证,${idNumber},成人,36,男,`,
          ),
          mode: 'replace',
        },
      },
    );

    expectStatus(response, 409);
    expect(response.body.code).toBe('TOURIST_DOCUMENT_CONFLICT');
    expect(response.body.details.errors.length).toBeGreaterThan(0);

    // 覆盖模式在库里已经被删过一遍，回滚后必须还是 3 个人。
    const roster = await call<RosterBody>(`/api/orders/${orderId}/tourists`);
    expect(roster.body.roster.total).toBe(3);
  });

  it('覆盖导入：老名单被清掉，只剩文件里的人', async () => {
    const response = await call<{ inserted: number; deleted: number }>(
      `/api/orders/${orderId}/tourists/import`,
      {
        method: 'POST',
        body: {
          csv: csv(`唯一游客,13900000104,台胞证,T${suffix},成人,29,女,覆盖测试`),
          mode: 'replace',
        },
      },
    );

    expectStatus(response, 200);
    expect(response.body).toEqual({ inserted: 1, deleted: 3 });

    const roster = await call<RosterBody>(`/api/orders/${orderId}/tourists`);
    expect(roster.body.roster.total).toBe(1);
    expect(roster.body.roster.items[0]?.name).toBe('唯一游客');
  });

  it('财务能看名单但不能改', async () => {
    const read = await call<RosterBody>(`/api/orders/${orderId}/tourists`, { actor: 'finance' });
    expectStatus(read, 200);

    const write = await call<{ code: string }>(`/api/orders/${orderId}/tourists`, {
      actor: 'finance',
      method: 'POST',
      body: { name: '财务想加的人', personType: 'adult' },
    });
    expectStatus(write, 403);
    expect(write.body.code).toBe('FORBIDDEN');
  });

  it('模板是带 BOM 的八列表头', async () => {
    const response = await call<{ filename: string; content: string }>(
      '/api/tourists/import-template',
    );

    expectStatus(response, 200);
    expect(
      response.body.content.startsWith('\uFEFF姓名,手机,证件类型,证件号,成人/儿童,年龄,性别,备注'),
    ).toBe(true);
  });

  it('删除单个游客后名单少一人', async () => {
    const roster = await call<RosterBody>(`/api/orders/${orderId}/tourists`);
    const target = roster.body.roster.items[0];
    if (!target) throw new Error('预期名单里至少有一个人');

    const response = await call<{ deletedTouristId: string }>(
      `/api/orders/${orderId}/tourists/${target.id}`,
      { method: 'DELETE' },
    );

    expectStatus(response, 200);
    const after = await call<RosterBody>(`/api/orders/${orderId}/tourists`);
    expect(after.body.roster.total).toBe(0);
  });
});
