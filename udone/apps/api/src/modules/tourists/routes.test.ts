import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '@erp/contracts';
import { app } from '../../index';
import type { ApiEnvironment } from '../../middleware/auth';
import type { TouristRecord, TouristRepository } from './tourist-service';
import { TouristDocumentConflictError } from './tourist-service';

const adminIdentity: AuthContext = {
  userId: 'user-owner',
  organizationId: 'org-alpha',
  role: 'admin',
  sessionId: 'session-1',
  permissions: ['order.read', 'order.write', 'customer.sensitive.read'],
  dataScope: 'all',
};

/** 计调员没有 `customer.sensitive.read`：名单读得到，证件号只能是掩码。 */
const operatorIdentity: AuthContext = {
  ...adminIdentity,
  role: 'operator',
  permissions: ['order.read', 'order.write'],
  dataScope: 'own',
};

/** 财务只有 order.read：能看名单，不能改。 */
const financeIdentity: AuthContext = {
  ...adminIdentity,
  role: 'finance',
  permissions: ['order.read'],
};

function tourist(overrides: Partial<TouristRecord> = {}): TouristRecord {
  return {
    id: 'tourist-1',
    name: '张一',
    phone: '13800000101',
    documentType: 'id_card',
    documentNumber: '110101199001011234',
    personType: 'adult',
    age: 36,
    gender: 'male',
    createdAt: '2026-11-16T00:00:00Z',
    updatedAt: '2026-11-16T00:00:00Z',
    ...overrides,
  };
}

function repositoryStub(overrides: Partial<TouristRepository> = {}): TouristRepository {
  return {
    readRoster: vi.fn().mockResolvedValue({
      items: [tourist()],
      declared: { adultCount: 1, childCount: 0 },
    }),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue(null),
    remove: vi.fn().mockResolvedValue(false),
    listDocuments: vi.fn().mockResolvedValue([]),
    importRows: vi.fn().mockResolvedValue({ inserted: 0, deleted: 0 }),
    ...overrides,
  };
}

function setup(repository: TouristRepository, identity: AuthContext = adminIdentity) {
  const testApp = new Hono<ApiEnvironment>();
  testApp.route('/', app);
  const env: ApiEnvironment['Bindings'] = {
    AUTH_VERIFIER: {
      verify: vi.fn().mockResolvedValue(identity),
      hasPermission: vi.fn(async (context, permission) => context.permissions.includes(permission)),
    },
    TOURIST_REPOSITORY: repository,
  };
  return { testApp, env };
}

const authHeaders = { Authorization: 'Bearer valid-token', 'X-Organization-ID': 'org-alpha' };
const jsonHeaders = { ...authHeaders, 'Content-Type': 'application/json' };

const HEADER = '姓名,手机,证件类型,证件号,成人/儿童,年龄,性别,备注';

function csv(...rows: string[]): string {
  return `\uFEFF${[HEADER, ...rows].join('\r\n')}\r\n`;
}

describe('tourist roster routes', () => {
  it('returns the roster with the declared counts from the order', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/orders/order-1/tourists',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      roster: { total: number; adultCount: number; declaredAdultCount: number };
    };
    expect(body.roster).toMatchObject({ total: 1, adultCount: 1, declaredAdultCount: 1 });
  });

  it('masks the document number for a role without customer.sensitive.read', async () => {
    const { testApp, env } = setup(repositoryStub(), operatorIdentity);

    const response = await testApp.request(
      '/api/orders/order-1/tourists',
      { headers: authHeaders },
      env,
    );
    const body = (await response.json()) as {
      roster: { items: Array<{ documentNumber?: string; documentNumberMasked?: string }> };
    };

    expect(body.roster.items[0]?.documentNumber).toBeUndefined();
    expect(body.roster.items[0]?.documentNumberMasked).toBe('11**************34');
  });

  it('returns 404 when the order is outside the caller scope', async () => {
    const { testApp, env } = setup(
      repositoryStub({ readRoster: vi.fn().mockResolvedValue(null) }),
      operatorIdentity,
    );

    const response = await testApp.request(
      '/api/orders/order-9/tourists',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(404);
  });

  it('creates a tourist and returns the masked view for a non-sensitive role', async () => {
    const create = vi.fn().mockResolvedValue(tourist());
    const { testApp, env } = setup(repositoryStub({ create }), operatorIdentity);

    const response = await testApp.request(
      '/api/orders/order-1/tourists',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          name: '张一',
          personType: 'adult',
          documentType: 'id_card',
          documentNumber: '110101199001011234',
        }),
      },
      env,
    );

    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith(
      'org-alpha',
      'order-1',
      expect.objectContaining({ name: '张一', documentType: 'id_card' }),
    );
    const body = (await response.json()) as { tourist: { documentNumber?: string } };
    expect(body.tourist.documentNumber).toBeUndefined();
  });

  it('rejects a document number without a document type', async () => {
    const create = vi.fn();
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: '张一', personType: 'adult', documentNumber: 'E123' }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });

  it('reports a duplicate document as TOURIST_DOCUMENT_CONFLICT', async () => {
    const create = vi.fn().mockRejectedValue(new TouristDocumentConflictError());
    const { testApp, env } = setup(repositoryStub({ create }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: '张一', personType: 'adult' }),
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('TOURIST_DOCUMENT_CONFLICT');
  });

  it('requires the document type when a patch changes the document number', async () => {
    const update = vi.fn();
    const { testApp, env } = setup(repositoryStub({ update }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists/tourist-1',
      {
        method: 'PATCH',
        headers: jsonHeaders,
        body: JSON.stringify({ documentNumber: 'E7654321' }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets finance read the roster but not change it', async () => {
    const { testApp, env } = setup(repositoryStub(), financeIdentity);

    const read = await testApp.request(
      '/api/orders/order-1/tourists',
      { headers: authHeaders },
      env,
    );
    expect(read.status).toBe(200);

    const write = await testApp.request(
      '/api/orders/order-1/tourists',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ name: '张一', personType: 'adult' }),
      },
      env,
    );
    expect(write.status).toBe(403);
  });

  it('previews a CSV without writing anything', async () => {
    const importRows = vi.fn();
    const { testApp, env } = setup(repositoryStub({ importRows }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists/import-preview',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          csv: csv('李二,13900000102,护照,E12345678,儿童,8,女,'),
          mode: 'append',
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      totalRows: number;
      validRows: number;
      errors: unknown[];
      summary: { personCount: number };
    };
    expect(body).toMatchObject({ totalRows: 1, validRows: 1 });
    expect(body.errors).toEqual([]);
    // 追加模式：名单里已有 1 人 + 这 1 行 = 2 人。
    expect(body.summary.personCount).toBe(2);
    expect(importRows).not.toHaveBeenCalled();
  });

  it('reports rows already in the roster as duplicates during preview', async () => {
    const listDocuments = vi
      .fn()
      .mockResolvedValue([
        { name: '张一', documentType: 'id_card', normalizedDocumentNumber: '110101199001011234' },
      ]);
    const { testApp, env } = setup(repositoryStub({ listDocuments }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists/import-preview',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          csv: csv('张一重复,110101-19900101-1234 ,身份证,110101-19900101-1234,成人,36,男,'),
        }),
      },
      env,
    );

    const body = (await response.json()) as { errors: Array<{ line: number; message: string }> };
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]?.line).toBe(2);
    expect(body.errors[0]?.message).toContain('张一');
  });

  it('rejects the whole import when a row is invalid', async () => {
    const importRows = vi.fn();
    const { testApp, env } = setup(repositoryStub({ importRows }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists/import',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({ csv: csv('李二,139,护照,,成年,8,女,') }),
      },
      env,
    );

    expect(response.status).toBe(400);
    expect(importRows).not.toHaveBeenCalled();
  });

  it('rejects duplicates inside one file before touching the database', async () => {
    const importRows = vi.fn();
    const { testApp, env } = setup(repositoryStub({ importRows }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists/import',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          csv: csv(
            '甲,139,身份证,110101199001011234,成人,36,男,',
            '乙,139,身份证,110101-19900101-1234,成人,30,女,',
          ),
          mode: 'replace',
        }),
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe('TOURIST_DOCUMENT_CONFLICT');
    expect(importRows).not.toHaveBeenCalled();
  });

  it('imports the parsed rows through the repository', async () => {
    const importRows = vi.fn().mockResolvedValue({ inserted: 2, deleted: 0 });
    const { testApp, env } = setup(repositoryStub({ importRows }));

    const response = await testApp.request(
      '/api/orders/order-1/tourists/import',
      {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          csv: csv('甲,139,身份证,110101199001011234,成人,36,男,', '乙,,,,儿童,8,女,'),
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ inserted: 2, deleted: 0 });
    expect(importRows).toHaveBeenCalledWith(
      'org-alpha',
      'order-1',
      'append',
      expect.arrayContaining([
        expect.objectContaining({ name: '甲', documentType: 'id_card', personType: 'adult' }),
        expect.objectContaining({ name: '乙', personType: 'child' }),
      ]),
    );
  });

  it('serves the import template with a UTF-8 BOM', async () => {
    const { testApp, env } = setup(repositoryStub());

    const response = await testApp.request(
      '/api/tourists/import-template',
      { headers: authHeaders },
      env,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { filename: string; content: string };
    expect(body.filename).toContain('.csv');
    expect(
      body.content.startsWith('\uFEFF姓名,手机,证件类型,证件号,成人/儿童,年龄,性别,备注'),
    ).toBe(true);
  });
});
