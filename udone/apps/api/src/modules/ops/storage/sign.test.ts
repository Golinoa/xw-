import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiEnvironment } from '../../../middleware/auth';
import {
  SIGNED_URL_TTL_SECONDS,
  STORAGE_BUCKETS,
  StorageSignError,
  createSignedDownload,
  createSignedUpload,
  encodeStorageKey,
  joinStorageUrl,
  storageBaseOf,
} from './sign';

/**
 * 这里测的是**这条路本身**，不是它被谁调用。
 *
 * 此前 `sign.ts` 一条单测都没有：它的所有分支只在下游的合同路由测试里被
 * 顺带走过一遍，而那条路径只喂一种输入（Supabase 最常见的那种回包）。于是
 * 「base 没配」「存储回绝对地址」「回包缺字段」这三类分支从来没有被单独执行过，
 * 它们对不对，取决于有没有人碰巧踩到。
 */

const SERVICE_KEY = 'test-service-role-key';

const env = (overrides: Record<string, string | undefined> = {}) =>
  ({
    OPS_STORAGE_PUBLIC_URL: 'https://demo.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    ...overrides,
  }) as unknown as ApiEnvironment['Bindings'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('storageBaseOf', () => {
  it('strips trailing slashes so the joined URL never doubles up', () => {
    expect(storageBaseOf(env({ OPS_STORAGE_PUBLIC_URL: 'https://demo.supabase.co///' }))).toBe(
      'https://demo.supabase.co',
    );
  });

  it('falls back to the local stack when the binding is absent', () => {
    // 后端在测试里跑时不注入任何东西，这里必须是 54321 而不是空串——空串会
    // 拼出 `/storage/v1/object/...` 这种相对地址，fetch 直接抛「Failed to parse URL」。
    expect(storageBaseOf(env({ OPS_STORAGE_PUBLIC_URL: undefined }))).toBe(
      'http://127.0.0.1:54321',
    );
  });
});

describe('encodeStorageKey', () => {
  it('encodes each segment but keeps the slashes that carry the hierarchy', () => {
    expect(encodeStorageKey('c1/a1/合同 #1.pdf')).toBe('c1/a1/%E5%90%88%E5%90%8C%20%231.pdf');
  });
});

describe('joinStorageUrl', () => {
  const base = 'https://demo.supabase.co';

  it('joins the path Supabase actually returns', () => {
    expect(joinStorageUrl(base, '/object/sign/ops-contracts/a.pdf?token=t')).toBe(
      `${base}/storage/v1/object/sign/ops-contracts/a.pdf?token=t`,
    );
  });

  it('adds the missing leading slash instead of gluing the prefix to the first segment', () => {
    // 少了这道处理的结果是 `.../storage/v1object/sign/...`：浏览器把它当成
    // 端口号后面的一整段路径，回 404，而 404 看起来像「对象不存在」。
    expect(joinStorageUrl(base, 'object/sign/ops-contracts/a.pdf')).toBe(
      `${base}/storage/v1/object/sign/ops-contracts/a.pdf`,
    );
  });

  it('does not double the prefix when the storage already returned one', () => {
    expect(joinStorageUrl(base, '/storage/v1/object/sign/ops-contracts/a.pdf')).toBe(
      `${base}/storage/v1/object/sign/ops-contracts/a.pdf`,
    );
  });

  it('leaves an absolute URL alone', () => {
    expect(joinStorageUrl(base, 'https://cdn.example.com/object/sign/x')).toBe(
      'https://cdn.example.com/object/sign/x',
    );
  });
});

describe('createSignedUpload', () => {
  it('asks the upload endpoint and returns the contract field names', async () => {
    const fetchMock = vi.fn(async () =>
      json({ url: '/object/upload/sign/ops-contracts/c1/a1/x.pdf?token=t' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const signed = await createSignedUpload(env(), 'c1/a1/x.pdf');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://demo.supabase.co/storage/v1/object/upload/sign/ops-contracts/c1/a1/x.pdf',
    );
    expect(JSON.parse(init.body as string)).toStrictEqual({ expiresIn: SIGNED_URL_TTL_SECONDS });
    // 两个头缺一不可：Supabase 的网关先看 `apikey` 再看 `Authorization`，
    // 只带一个在真机上都是 401，而本地替身不校验时这条路径永远绿。
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SERVICE_KEY}`);
    expect((init.headers as Record<string, string>).apikey).toBe(SERVICE_KEY);
    expect(signed.uploadUrl).toContain('/object/upload/sign/ops-contracts/c1/a1/x.pdf?token=t');
    expect(new Date(signed.uploadExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('signs into the bucket it is told to, not always the contract one', async () => {
    // 导出桶（`ops-exports`）此前定义了却没人用：两个签名函数都把 bucket 写死成
    // `ops-contracts`。写死的后果不是报错，是导出文件被签进合同桶——两个桶的
    // 保留期不同，清理任务会按错的那条去删。
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(url);
        return json({ url: '/object/upload/sign/ops-exports/e.zip' });
      }),
    );

    await createSignedUpload(env(), 'e.zip', STORAGE_BUCKETS.exports);

    expect(requested[0]).toContain('/ops-exports/e.zip');
  });
});

describe('createSignedDownload', () => {
  it('accepts the camelCase alias as well as the documented field', async () => {
    // Supabase 的 HTTP 直调回 `signedURL`，但经过某些代理会变成 `signedUrl`。
    // 只认一个的后果不是「拿不到」，而是拼出 `...?token=undefined` 这种
    // 看起来正常的坏链接。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ signedUrl: '/object/sign/b/k?token=t' })),
    );

    const signed = await createSignedDownload(env(), 'b/k');

    expect(signed.url).toBe('https://demo.supabase.co/storage/v1/object/sign/b/k?token=t');
  });

  it('refuses to invent a link when the response carries no path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ signedURL: '' })),
    );

    await expect(createSignedDownload(env(), 'b/k')).rejects.toBeInstanceOf(StorageSignError);
  });
});

describe('failure surface', () => {
  it('says which variable is missing instead of sending a request that will 401', async () => {
    const fetchMock = vi.fn(async () => json({ signedURL: '/object/sign/b/k?token=t' }));
    vi.stubGlobal('fetch', fetchMock);

    const error = await createSignedDownload(env({ SUPABASE_SERVICE_ROLE_KEY: '' }), 'k').catch(
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(StorageSignError);
    expect((error as StorageSignError).message).toContain('SUPABASE_SERVICE_ROLE_KEY');
    // 不发请求：发了只会得到 `storage answered 401`，而那一句话会让人去查
    // 桶和策略，真正缺的是一个环境变量。
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('names the bucket when storage answers 404', async () => {
    // 部署时漏建 `ops-exports` 就是这个形状。只说「404」会让人去查对象路径，
    // 而真正缺的是整个桶。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ message: 'not found' }, 404)),
    );

    await expect(createSignedDownload(env(), 'k', STORAGE_BUCKETS.exports)).rejects.toMatchObject({
      name: 'StorageSignError',
      message: expect.stringContaining('ops-exports'),
      detail: { status: 404, bucket: 'ops-exports', key: 'k' },
    });
  });

  it('reports an unreachable storage without a status, so the caller can tell it apart', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const error = await createSignedDownload(env(), 'k').catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(StorageSignError);
    // 键不存在，而不是值为 undefined：调用方按 `'status' in detail` 判断是
    // 「连不上」还是「存储回了 4xx」，两者的处置不同（改网络 vs 改 bucket）。
    expect(error as StorageSignError).toMatchObject({
      detail: { bucket: 'ops-contracts', key: 'k' },
    });
    expect('status' in (error as StorageSignError).detail).toBe(false);
  });
});
