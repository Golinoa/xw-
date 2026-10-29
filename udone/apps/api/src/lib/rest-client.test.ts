import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiHttpError } from '../middleware/error-handler';
import { RestConflictError, RestRequestError, createRestClient } from './rest-client';

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
