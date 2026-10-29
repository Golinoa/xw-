import { describe, expect, it, vi } from 'vitest';
import { ApiClientError, ContractViolationError, createApiClient } from './api-client';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const meBody = {
  userId: 'user-1',
  memberships: [{ organizationId: 'org-a', organizationName: 'Alpha', role: 'admin' }],
};

function client(fetcher: typeof fetch) {
  return createApiClient({
    getAccessToken: () => 'token-1',
    getOrganizationId: () => 'org-a',
    fetcher,
    retryDelayMs: 0,
  });
}

describe('typed API client', () => {
  it('returns the parsed payload and sends the trusted headers', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(meBody));
    const result = await client(fetcher).call('me');

    expect(result).toEqual(meBody);
    expect(fetcher).toHaveBeenCalledWith(
      '/api/me',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Organization-ID': 'org-a',
        }),
      }),
    );
  });

  it('fills path parameters and refuses to send an incomplete path', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ members: [] }));
    const api = client(fetcher);

    await api.call('listMembers', { params: { id: 'org-a' } });
    expect(fetcher).toHaveBeenCalledWith('/api/organizations/org-a/members', expect.anything());

    await expect(api.call('listMembers', { params: {} as { id: string } })).rejects.toThrow(
      /缺少路径参数 id/,
    );
  });

  it('blocks a request body that does not satisfy the contract before calling the API', async () => {
    const fetcher = vi.fn();
    const api = client(fetcher);

    await expect(api.call('createOrganization', { body: { name: '' } })).rejects.toBeInstanceOf(
      ContractViolationError,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('throws a contract violation when the response misses a field', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ userId: 'user-1' }));

    await expect(client(fetcher).call('me')).rejects.toMatchObject({
      name: 'ContractViolationError',
      direction: 'response',
      issues: [expect.objectContaining({ path: 'memberships' })],
    });
  });

  it('maps stable error codes to readable Chinese messages', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        jsonResponse(
          { code: 'FORBIDDEN', message: 'You cannot access this organization', requestId: 'r-1' },
          403,
        ),
      );

    await expect(client(fetcher).call('me')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: '当前账号无权执行该操作',
      requestId: 'r-1',
      status: 403,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not retry client errors but retries server errors', async () => {
    const forbidden = vi
      .fn()
      .mockResolvedValue(jsonResponse({ code: 'FORBIDDEN', message: 'x', requestId: 'r' }, 403));
    await expect(client(forbidden).call('me')).rejects.toBeInstanceOf(ApiClientError);
    expect(forbidden).toHaveBeenCalledOnce();

    const unhealthy = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ code: 'INTERNAL_ERROR', message: 'x', requestId: 'r' }, 500),
      )
      .mockResolvedValueOnce(
        jsonResponse({ code: 'INTERNAL_ERROR', message: 'x', requestId: 'r' }, 500),
      )
      .mockResolvedValueOnce(jsonResponse(meBody));

    await expect(client(unhealthy).call('me')).resolves.toEqual(meBody);
    expect(unhealthy).toHaveBeenCalledTimes(3);
  });

  it('requires an access token before sending', async () => {
    const api = createApiClient({ getAccessToken: () => null, fetcher: vi.fn() });

    await expect(api.call('me')).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
