// 本地 Storage 替身的行为测试。
//
// 这些断言的价值不在于「替身写对了」，而在于它们把三条只能在真 Storage 上
// 观察到的性质固定下来：签名绑对象、签名会过期、bucket 私有。合同附件与导出
// 两处的下载 URL 都依赖这三条，而它们此前一条都没有被验证过。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { __test__, createStorageServer, signToken } from './local-storage.mjs';

const SECRET = 'storage-test-secret';
/**
 * 替身认的是「签得过且 role 是 service_role 的 JWT」，不是一个固定字符串——
 * 与 Supabase 一致。夹具因此可以自己签一个，不必与环境变量对齐。
 */
const SERVICE_KEY = signToken(SECRET, {
  role: 'service_role',
  exp: Math.floor(Date.now() / 1000) + 3600,
});
const BUCKET = 'ops-contracts';

let service;
let base;
let root;

beforeAll(async () => {
  // 临时目录用 mkdtemp：并行跑两份测试（两个 worktree）时共用一个固定路径，
  // 上一个用例写进去的对象会让「删除后 HEAD 应为 404」这类断言变成偶发红。
  root = mkdtempSync(join(tmpdir(), 'udone-storage-'));
  service = createStorageServer({ root, jwtSecret: SECRET, port: 0 });
  base = `http://127.0.0.1:${await service.listen()}/storage/v1`;
});

afterAll(async () => {
  await service.close();
  rmSync(root, { recursive: true, force: true });
});

/** 与生产同形的 key：含中文、空格、`#`、括号——这几个字符各自会坏一种拼法。 */
const fileName = '合同 #1 (终版).pdf';
const objectKey = `c1/a1/${fileName}`;
const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');

/**
 * 两个签名端点的路径不对称：下载是 `/object/sign/`，上传是
 * `/object/upload/sign/`。这是 Supabase 的形状，不是笔误。
 */
const serviceHeaders = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
};

const sign = (mode, key = encodedKey) => {
  const path = mode === 'upload' ? '/object/upload/sign' : '/object/sign';
  return fetch(`${base}${path}/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...serviceHeaders },
    body: JSON.stringify({ expiresIn: 300 }),
  });
};

const bearer = () => ({ ...serviceHeaders });

describe('signed upload and download', () => {
  it('round-trips bytes through a signed upload URL', async () => {
    const signed = await sign('upload');
    expect(signed.status).toBe(200);
    const { url } = await signed.json();

    // 签出来的 URL 必须自己能用：`#` 不编码时，后半段会被浏览器当成 fragment
    // 丢掉，上传实际写到一个截断的名字上，而响应仍是 200。
    expect(url).toContain('%23');
    expect(url).toContain('%20');

    const put = await fetch(`${base}${url}`, { method: 'PUT', body: Buffer.from('hello-storage') });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ Key: `${BUCKET}/${objectKey}` });

    const signedDownload = await sign('download');
    const { signedURL } = await signedDownload.json();
    const got = await fetch(`${base}${signedURL}`);
    expect(got.status).toBe(200);
    expect(await got.text()).toBe('hello-storage');
  });

  it('binds the token to one object, so reusing it on another path fails', async () => {
    await fetch(`${base}${(await (await sign('upload')).json()).url}`, {
      method: 'PUT',
      body: Buffer.from('x'),
    });
    const { signedURL } = await (await sign('download')).json();
    const token = signedURL.split('token=')[1];

    const reused = await fetch(`${base}/object/sign/${BUCKET}/c1/a1/other.pdf?token=${token}`);
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ message: 'Invalid JWT: url claim mismatch' });
  });

  it('rejects an expired token instead of serving the object forever', async () => {
    const expired = __test__.signToken(SECRET, {
      url: `${BUCKET}/${objectKey}`,
      exp: Math.floor(Date.now() / 1000) - 5,
    });
    const response = await fetch(`${base}/object/sign/${BUCKET}/${encodedKey}?token=${expired}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Invalid JWT: expired' });
  });

  it('rejects a token whose signature was tampered with', async () => {
    const valid = __test__.signToken(SECRET, {
      url: `${BUCKET}/${objectKey}`,
      exp: Math.floor(Date.now() / 1000) + 60,
    });
    const parts = valid.split('.');
    const tampered = [parts[0], parts[1], `${parts[2].slice(0, -2)}xx`].join('.');
    const response = await fetch(`${base}/object/sign/${BUCKET}/${encodedKey}?token=${tampered}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Invalid JWT: signature mismatch' });
  });

  it('refuses expiresIn outside the range Supabase accepts', async () => {
    for (const expiresIn of [0, -1, 604801]) {
      const response = await fetch(`${base}/object/sign/${BUCKET}/${encodedKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serviceHeaders },
        body: JSON.stringify({ expiresIn }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('refuses to sign without a service_role key', async () => {
    // 这一条是替身存在的第二个理由：签发端点此前**完全不鉴权**，于是 API
    // 漏带凭据在本地一路绿，到 Supabase 上每个附件端点都 401。本地替身若
    // 比线上宽松，它保护的就不是「线上会怎样」而是「本地能过」。
    for (const headers of [
      {},
      { Authorization: 'Bearer some-user-token' },
      // 只带 Authorization 不带 apikey：Supabase 的网关先校验后者，真机上
      // 这种请求会被拦在网关而不是 storage-api，本地照同一个顺序拦。
      { Authorization: `Bearer ${SERVICE_KEY}` },
    ]) {
      const response = await fetch(`${base}/object/sign/${BUCKET}/${encodedKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ expiresIn: 300 }),
      });
      expect(response.status).toBe(401);
    }
  });
});

describe('bucket privacy', () => {
  it('answers 401 on a direct read without a bearer token', async () => {
    const response = await fetch(`${base}/object/${BUCKET}/${encodedKey}`);
    expect(response.status).toBe(401);
  });

  it('serves a direct read with a bearer token', async () => {
    const response = await fetch(`${base}/object/${BUCKET}/${encodedKey}`, {
      headers: bearer(),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('x');
  });

  it('answers 404 for an unknown bucket rather than inventing an empty one', async () => {
    const response = await fetch(`${base}/object/sign/ops-unknown/a.pdf`, {
      method: 'POST',
      body: JSON.stringify({ expiresIn: 60 }),
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'Bucket not found' });
  });

  it('is idempotent on delete', async () => {
    const first = await fetch(`${base}/object/${BUCKET}/${encodedKey}`, {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${base}/object/${BUCKET}/${encodedKey}`, {
      method: 'DELETE',
      headers: bearer(),
    });
    expect(second.status).toBe(200);
    const head = await fetch(`${base}/object/${BUCKET}/${encodedKey}`, {
      method: 'HEAD',
      headers: bearer(),
    });
    expect(head.status).toBe(404);
  });
});

describe('path handling', () => {
  it('refuses traversal encoded as %2F inside a segment', async () => {
    const response = await fetch(`${base}/object/${BUCKET}/..%2F..%2Fetc/passwd`, {
      headers: bearer(),
    });
    // `..%2F..%2Fetc` 按 `/` 切不开，是**一段**；只比 `..` 会放过它，
    // decode 之后才变成 `../../etc`。
    expect(response.status).toBe(400);
  });

  it('refuses traversal written as dotted segments', () => {
    // 这条直接调纯函数：Node 的 fetch 在发请求前就把 `%2e%2e` 归一化成 `..`
    // 并从路径里吃掉了，走 HTTP 只能验到 404，验不到「服务端有没有拦」。
    expect(__test__.resolveObjectPath(root, BUCKET, '%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(__test__.resolveObjectPath(root, BUCKET, 'a/./b')).toBeNull();
    expect(__test__.resolveObjectPath(root, BUCKET, 'a//b')).toBeNull();
    expect(__test__.resolveObjectPath(root, BUCKET, 'a/%E0%A4%A')).toBeNull();
  });

  it('keeps the directory shape of a segmented key', () => {
    const resolved = __test__.resolveObjectPath(root, BUCKET, 'c1/a1/f.pdf');
    expect(resolved.key).toBe('c1/a1/f.pdf');
    expect(resolved.segments).toEqual(['c1', 'a1', 'f.pdf']);
  });
});
