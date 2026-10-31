// 本地 Supabase Storage 替身。
//
// 为什么需要它：线上用 Supabase Storage 签下载 URL，本地这套栈里没有
// `/storage/v1`，于是「签名」那一段只能退化成「拼一个形状像的 URL + 随机
// token」——形状对、语义假。假签名让三件事在本地永远验不出来：
//
//   ① 过期：token 带 `exp`，5 分钟后必须 400，而不是永远能下；
//   ② 越权：token 把 `<bucket>/<path>` 绑进 payload，换一个 path 复用同一个
//      token 必须失败——这是「签名 URL 只对一个对象有效」的全部内容；
//   ③ 私有：不经签名的 `/object/` 直读要 `Authorization`，bucket 不存在是
//      404 而不是「读到一个空文件」。
//
// 刻意不像 Supabase 的地方只有一处：过期判定用毫秒时钟直接比，不模拟它的
// 时钟偏移容忍窗口。多模拟一层就多一个「本地通过、线上不通过」的分岔。
//
// 实现选 Node 内建 http 而不是引依赖：与 local-db.mjs 的风格一致（那套栈的
// 全部依赖只有命令行 psql 与 PostgREST 二进制），且这个服务只在测试里活。
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 默认两个 bucket，与线上要建的两个同名：附件跟合同走，导出跟保留期走。 */
const DEFAULT_BUCKETS = ['ops-contracts', 'ops-exports'];

/** Supabase 的默认上限是 50MB；本地同值，避免「本地能传、线上 413」。 */
const MAX_BYTES = 50 * 1024 * 1024;

const b64url = (buffer) => Buffer.from(buffer).toString('base64url');

function signToken(secret, payload) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = `${header}.${body}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

/**
 * 验签 + 验过期。
 *
 * 返回 `{ ok: true, payload }` 或 `{ ok: false, status, message }`——把 HTTP
 * 状态码放进返回值而不是直接写响应，是为了让它能被单测直接调，不必起端口。
 */
function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || token.split('.').length !== 3) {
    return { ok: false, status: 400, message: 'Invalid JWT: malformed' };
  }

  const [header, body, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest();
  const actual = Buffer.from(signature, 'base64url');

  // 长度不等时 timingSafeEqual 会抛，先比长度再比内容。
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, status: 400, message: 'Invalid JWT: signature mismatch' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  } catch {
    return { ok: false, status: 400, message: 'Invalid JWT: payload is not JSON' };
  }

  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return { ok: false, status: 400, message: 'Invalid JWT: expired' };
  }

  return { ok: true, payload };
}

function readBody(request, limit = MAX_BYTES) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(Object.assign(new Error('Entity too large'), { status: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolvePromise(Buffer.concat(chunks)));
    request.on('error', rejectPromise);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

/** Supabase 的错误体长这样：`{statusCode, error, message}`。保持一致。 */
function sendError(response, status, error, message) {
  sendJson(response, status, { statusCode: String(status), error, message });
}

/**
 * 把 URL 里的路径段还原成 `{ segments, key, target }`，同时挡住穿越。
 *
 * `storage_path` 的最后一段是用户给的文件名（中文、空格、`#` 都可能有），
 * API 侧按段 `encodeURIComponent`，这里就按段 decode——整段 decode 会把
 * `%2F` 还原成 `/`，层级被打乱。
 *
 * 三条拒绝规则，第二条是冒烟时才补上的：只比 `..` 不够，`..%2F..%2Fetc`
 * 是**一段**（`split('/')` 切不开它），decode 之后才变成 `../../etc`。
 * 段内出现分隔符一律拒绝，因为一个「段」按定义不含分隔符。
 */
function resolveObjectPath(root, bucket, rawPath) {
  let segments;
  try {
    segments = rawPath.split('/').map(decodeURIComponent);
  } catch {
    return null;
  }

  const invalid = segments.some(
    (segment) =>
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      segment.includes('/') ||
      segment.includes('\\'),
  );
  if (invalid) return null;

  return {
    segments,
    key: segments.join('/'),
    target: join(root, bucket, ...segments),
  };
}

/** 签发出去的 URL 必须自己能用：`#` 不编码会把后半段变成 fragment。 */
function encodeKey(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

/**
 * 启动本地 Storage。
 *
 * @param {object} options
 * @param {string} options.root      对象落盘目录（默认 $WORK_DIR/storage）
 * @param {string} options.jwtSecret 与 PostgREST 共用同一个 secret
 * @param {string[]} [options.buckets]
 * @param {number} [options.port]
 */
export function createStorageServer({ root, jwtSecret, buckets = DEFAULT_BUCKETS, port = 0 }) {
  for (const bucket of buckets) {
    mkdirSync(join(root, bucket), { recursive: true });
  }

  const hasBucket = (bucket) => buckets.includes(bucket);

  /**
   * 校验直连请求的 Bearer。本地没有 JWT 签发链的全部角色，只要求
   * 「有 token 且验得过」——服务端调度的 service_role 与用户令牌在这里等价，
   * 因为这条路径验的是「不经签名拿不到」，不是「谁的令牌能拿」。
   */
  const requireBearer = (request) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    return verifyToken(jwtSecret, token);
  };

  const server = createServer(async (request, response) => {
    const rawUrl = request.url ?? '/';
    const [rawPath, rawQuery = ''] = rawUrl.split('?');
    const query = new URLSearchParams(rawQuery);
    const method = request.method ?? 'GET';

    if (!rawPath.startsWith('/storage/v1/')) {
      sendError(response, 404, 'NotFound', `unknown path ${rawPath}`);
      return;
    }

    const path = rawPath.slice('/storage/v1'.length);

    try {
      // ── 签名下载：POST 签发，GET 凭 token 取字节 ──────────────────────────
      const signedDownload = path.match(/^\/object\/sign\/([^/]+)\/(.+)$/);
      if (signedDownload) {
        const [, bucket, tail] = signedDownload;
        if (!hasBucket(bucket)) {
          sendError(response, 404, 'Bucket not found', `Bucket not found: ${bucket}`);
          return;
        }
        const resolved = resolveObjectPath(root, bucket, tail);
        if (!resolved) {
          sendError(response, 400, 'InvalidKey', 'invalid object path');
          return;
        }

        if (method === 'POST') {
          const body = await readBody(request);
          const parsed = body.length === 0 ? {} : JSON.parse(body.toString());
          const expiresIn = Number(parsed.expiresIn ?? 60);
          if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 604800) {
            sendError(response, 400, 'InvalidRequest', 'expiresIn must be 1..604800 seconds');
            return;
          }
          // payload 里绑的 `url` 是 `bucket/path`，不是完整 URL：Supabase 用的是
          // 相对 key，这样换 host 不用重签。
          const token = signToken(jwtSecret, {
            url: `${bucket}/${resolved.key}`,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + expiresIn,
          });
          sendJson(response, 200, {
            signedURL: `/object/sign/${bucket}/${encodeKey(resolved.key)}?token=${token}`,
          });
          return;
        }

        if (method === 'GET') {
          const verified = verifyToken(jwtSecret, query.get('token') ?? '');
          if (!verified.ok) {
            sendError(response, verified.status, 'InvalidJWT', verified.message);
            return;
          }
          // token 绑定了对象，换一个 path 复用同一个 token 必须失败。
          const expectedUrl = `${bucket}/${resolved.key}`;
          if (verified.payload.url !== expectedUrl) {
            sendError(response, 400, 'InvalidJWT', 'Invalid JWT: url claim mismatch');
            return;
          }
          if (!existsSync(resolved.target)) {
            sendError(response, 404, 'NotFound', 'Object not found');
            return;
          }
          const bytes = readFileSync(resolved.target);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bytes.length,
          });
          response.end(bytes);
          return;
        }

        sendError(response, 405, 'MethodNotAllowed', `${method} not allowed on signed download`);
        return;
      }

      // ── 签名上传：POST 签发，PUT 凭 token 写字节 ──────────────────────────
      const signedUpload = path.match(/^\/object\/upload\/sign\/([^/]+)\/(.+)$/);
      if (signedUpload) {
        const [, bucket, tail] = signedUpload;
        if (!hasBucket(bucket)) {
          sendError(response, 404, 'Bucket not found', `Bucket not found: ${bucket}`);
          return;
        }
        const resolved = resolveObjectPath(root, bucket, tail);
        if (!resolved) {
          sendError(response, 400, 'InvalidKey', 'invalid object path');
          return;
        }

        if (method === 'POST') {
          const body = await readBody(request);
          const parsed = body.length === 0 ? {} : JSON.parse(body.toString());
          const expiresIn = Number(parsed.expiresIn ?? 60);
          if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 604800) {
            sendError(response, 400, 'InvalidRequest', 'expiresIn must be 1..604800 seconds');
            return;
          }
          const token = signToken(jwtSecret, {
            url: `${bucket}/${resolved.key}`,
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + expiresIn,
          });
          // Supabase 这里回的是相对 url（与 signedURL 不同名，历史上就是两个拼写）。
          sendJson(response, 200, {
            url: `/object/upload/sign/${bucket}/${encodeKey(resolved.key)}?token=${token}`,
            token,
          });
          return;
        }

        if (method === 'PUT') {
          const verified = verifyToken(jwtSecret, query.get('token') ?? '');
          if (!verified.ok) {
            sendError(response, verified.status, 'InvalidJWT', verified.message);
            return;
          }
          if (verified.payload.url !== `${bucket}/${resolved.key}`) {
            sendError(response, 400, 'InvalidJWT', 'Invalid JWT: url claim mismatch');
            return;
          }
          const bytes = await readBody(request);
          mkdirSync(dirname(resolved.target), { recursive: true });
          writeFileSync(resolved.target, bytes);
          sendJson(response, 200, { Key: `${bucket}/${resolved.key}` });
          return;
        }

        sendError(response, 405, 'MethodNotAllowed', `${method} not allowed on signed upload`);
        return;
      }

      // ── 直连：要 Bearer，等价于「bucket 私有」 ────────────────────────────
      const direct = path.match(/^\/object\/([^/]+)\/(.+)$/);
      if (direct) {
        const [, bucket, tail] = direct;
        if (!hasBucket(bucket)) {
          sendError(response, 404, 'Bucket not found', `Bucket not found: ${bucket}`);
          return;
        }
        const resolved = resolveObjectPath(root, bucket, tail);
        if (!resolved) {
          sendError(response, 400, 'InvalidKey', 'invalid object path');
          return;
        }

        // HEAD 也要鉴权：允许匿名 HEAD 等于泄露「某个路径存在」。
        const verified = requireBearer(request);
        if (!verified.ok) {
          sendError(response, 401, 'Unauthorized', verified.message);
          return;
        }

        if (method === 'HEAD') {
          if (!existsSync(resolved.target)) {
            sendError(response, 404, 'NotFound', 'Object not found');
            return;
          }
          response.writeHead(200, { 'Content-Length': statSync(resolved.target).size });
          response.end();
          return;
        }

        if (method === 'GET') {
          if (!existsSync(resolved.target)) {
            sendError(response, 404, 'NotFound', 'Object not found');
            return;
          }
          const bytes = readFileSync(resolved.target);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': bytes.length,
          });
          response.end(bytes);
          return;
        }

        if (method === 'POST' || method === 'PUT') {
          const bytes = await readBody(request);
          mkdirSync(dirname(resolved.target), { recursive: true });
          writeFileSync(resolved.target, bytes);
          sendJson(response, 200, { Key: `${bucket}/${resolved.key}` });
          return;
        }

        if (method === 'DELETE') {
          // 删不存在的对象在 Supabase 里是 200（幂等），保持一致。
          rmSync(resolved.target, { force: true });
          sendJson(response, 200, { message: 'Successfully deleted' });
          return;
        }

        sendError(response, 405, 'MethodNotAllowed', `${method} not allowed`);
        return;
      }

      // bucket 列表与 health：本地调试方便，线上这两个形状不在契约里，
      // 所以不实现 `/bucket` 的创建与策略管理——那部分照抄只会让人误以为
      // 「策略也归这个替身管」。
      if (path === '/health') {
        sendJson(response, 200, { name: 'storage-local', buckets });
        return;
      }

      sendError(response, 404, 'NotFound', `unknown storage path ${path}`);
    } catch (cause) {
      const status = cause && typeof cause.status === 'number' ? cause.status : 500;
      sendError(
        response,
        status,
        status === 413 ? 'EntityTooLarge' : 'InternalError',
        cause.message,
      );
    }
  });

  return {
    server,
    listen() {
      return new Promise((resolvePromise, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen(port, '127.0.0.1', () => resolvePromise(server.address().port));
      });
    },
    close() {
      return new Promise((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

export const __test__ = { signToken, verifyToken, resolveObjectPath };
