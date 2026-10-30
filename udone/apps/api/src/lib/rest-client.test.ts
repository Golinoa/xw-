import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '../middleware/error-handler';
import {
  RestConflictError,
  RestRequestError,
  createRestClient,
  createServiceRestClient,
} from './rest-client';

const environment = {
  SUPABASE_URL: 'https://fixture.supabase.co/',
  SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
};

type FetchArgs = Parameters<typeof fetch>;
type FetchInit = FetchArgs[1];

function respondWith(body: string, status = 200) {
  const payload = status === 204 ? null : body;
  // A Response body can only be read once, so every call gets a fresh instance.
  const fetcher = vi.fn<typeof fetch>();
  fetcher.mockImplementation(() => Promise.resolve(new Response(payload, { status })));
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function headersOf(fetcher: ReturnType<typeof respondWith>, index = 0): Headers {
  const init: FetchInit | undefined = fetcher.mock.calls[index]?.[1];
  return new Headers(init?.headers);
}

afterEach(() => vi.unstubAllGlobals());

describe('createRestClient', () => {
  it('normalises the base URL and always sends the publishable key', async () => {
    const fetcher = respondWith('[]');

    await createRestClient(environment, 'caller-token').rest('organization_members?select=id');

    const [url] = fetcher.mock.calls[0]!;
    const headers = headersOf(fetcher);
    expect(url).toBe('https://fixture.supabase.co/rest/v1/organization_members?select=id');
    expect(headers.get('apikey')).toBe('fixture-publishable-key');
    expect(headers.get('Authorization')).toBe('Bearer caller-token');
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('forwards the verified organization context only when asked', async () => {
    const fetcher = respondWith('[]');
    const client = createRestClient(environment, 'caller-token');

    await client.rest('organization_members', { organizationId: 'org-one' });
    await client.rest('organization_members');

    expect(headersOf(fetcher, 0).get('X-Organization-ID')).toBe('org-one');
    expect(headersOf(fetcher, 1).has('X-Organization-ID')).toBe(false);
  });

  it('serialises a plain object body as JSON', async () => {
    const fetcher = respondWith('[]');

    await createRestClient(environment, 'caller-token').rest('rpc/create_organization_with_owner', {
      method: 'POST',
      body: { requested_name: 'New Org' },
    });

    const init = fetcher.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ requested_name: 'New Org' }));
  });

  it('returns undefined for 204 responses', async () => {
    respondWith('', 204);

    await expect(
      createRestClient(environment, 'caller-token').rest('noop'),
    ).resolves.toBeUndefined();
  });

  it('maps 409 and unique-violation responses to a conflict error', async () => {
    respondWith('{"message":"duplicate"}', 409);
    await expect(createRestClient(environment, 'caller-token').rest('x')).rejects.toBeInstanceOf(
      RestConflictError,
    );

    respondWith('{"code":"23505"}', 400);
    await expect(createRestClient(environment, 'caller-token').rest('x')).rejects.toBeInstanceOf(
      RestConflictError,
    );
  });

  it('treats a 416 range error as an empty page but keeps the total', async () => {
    // PostgREST 在 offset 超过总行数时返回 416，并带上 `Content-Range: */<total>`。
    // 当成错误抛出去的话，任何筛选后翻到第 2 页的用户都会看到 500。
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockImplementation(() =>
      Promise.resolve(new Response('[]', { status: 416, headers: { 'Content-Range': '*/1' } })),
    );
    vi.stubGlobal('fetch', fetcher);

    const page = await createRestClient(environment, 'caller-token').restPage(
      'customers?offset=10&limit=10',
    );

    expect(page).toEqual({ rows: [], total: 1 });
    expect(headersOf(fetcher).get('Prefer')).toBe('count=exact');
  });

  it('never leaks the upstream body in a server error message', async () => {
    respondWith('{"message":"relation secret_table does not exist"}', 500);

    const failure = await createRestClient(environment, 'caller-token')
      .rest('x')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RestRequestError);
    expect((failure as RestRequestError).status).toBe(500);
    expect((failure as Error).message).not.toContain('secret_table');
  });

  it('refuses to call anything when Supabase is not configured', async () => {
    const fetcher = respondWith('[]');

    const failure = await createRestClient({}, 'caller-token')
      .rest('x')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiHttpError);
    expect((failure as ApiHttpError).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns the raw auth response so callers keep their status branches', async () => {
    const fetcher = respondWith('{"error":"invalid"}', 401);

    const response = await createRestClient(environment, 'caller-token').auth('/auth/v1/user', {
      bearer: 'caller-token',
    });

    const [url] = fetcher.mock.calls[0]!;
    const headers = headersOf(fetcher);
    expect(url).toBe('https://fixture.supabase.co/auth/v1/user');
    expect(response.status).toBe(401);
    expect(headers.get('apikey')).toBe('fixture-publishable-key');
    expect(headers.get('Authorization')).toBe('Bearer caller-token');
  });

  it('can authenticate an auth call with the service-role key instead', async () => {
    const fetcher = respondWith('{}');

    await createRestClient(environment, 'caller-token').auth('/auth/v1/invite', {
      method: 'POST',
      apiKey: 'service-role-key',
      bearer: 'service-role-key',
      body: { email: 'invitee@example.com' },
    });

    const init = fetcher.mock.calls[0]?.[1];
    const headers = headersOf(fetcher);
    expect(headers.get('apikey')).toBe('service-role-key');
    expect(headers.get('Authorization')).toBe('Bearer service-role-key');
    expect(init?.body).toBe(JSON.stringify({ email: 'invitee@example.com' }));
  });
});

describe('schema profiles', () => {
  /**
   * PostgREST 用两个头区分「读哪个 schema」与「写进哪个 schema」。
   * 只发一个的后果不对称：写会静默落到 public，读会报「表不存在」。
   */
  it('sends no profile header unless one is requested', async () => {
    const fetcher = respondWith('[]');

    await createRestClient(environment, 'caller-token').rest('customers?select=id');

    const headers = headersOf(fetcher);
    expect(headers.get('Accept-Profile')).toBeNull();
    expect(headers.get('Content-Profile')).toBeNull();
  });

  it('sends Accept-Profile for a read and Content-Profile for a write', async () => {
    const fetcher = respondWith('[]');
    const client = createRestClient(environment, 'caller-token');

    await client.rest('idempotency_records?select=id', { profile: 'ops' });
    await client.rest('idempotency_records', {
      method: 'POST',
      profile: 'ops',
      body: { scope_key: 'k' },
    });

    const read = headersOf(fetcher, 0);
    expect(read.get('Accept-Profile')).toBe('ops');
    expect(read.get('Content-Profile')).toBeNull();

    const write = headersOf(fetcher, 1);
    expect(write.get('Content-Profile')).toBe('ops');
    expect(write.get('Accept-Profile')).toBeNull();
  });

  it('sends both profile headers on DELETE, which reads and writes', async () => {
    const fetcher = respondWith('', 204);

    await createRestClient(environment, 'caller-token').rest('idempotency_records?id=eq.1', {
      method: 'DELETE',
      profile: 'ops',
    });

    const headers = headersOf(fetcher);
    expect(headers.get('Accept-Profile')).toBe('ops');
    expect(headers.get('Content-Profile')).toBe('ops');
  });

  it('requires a service-role key before it will build a service client', () => {
    // 不做降级：拿 publishable key 冒充 service_role 会让请求以 anon 身份被拒，
    // 错误现场离原因很远。
    expect(() => createServiceRestClient(environment)).toThrow(ApiHttpError);
  });

  it('sends the service-role key as both apikey and bearer', async () => {
    const fetcher = respondWith('[]');
    const client = createServiceRestClient({
      ...environment,
      SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-role-key',
    });

    await client.rest('idempotency_records?select=id', { profile: 'ops' });

    const headers = headersOf(fetcher);
    expect(headers.get('apikey')).toBe('fixture-service-role-key');
    expect(headers.get('Authorization')).toBe('Bearer fixture-service-role-key');
  });
});
