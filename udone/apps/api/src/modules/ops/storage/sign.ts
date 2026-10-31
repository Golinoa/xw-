import type { ApiEnvironment } from '../../../middleware/auth';

/**
 * 对象存储的签名 URL。
 *
 * 为什么必须真的去问存储要签名，而不是自己拼一个：
 *
 * 上一版的做法是 `crypto.randomUUID()` 当 token，拼成
 * `/storage/v1/object/sign/<bucket>/<path>?token=<uuid>`。形状是对的，但
 * Supabase 的签名 URL 是**它自己签的 JWT**（payload 里绑 `url` 与 `exp`），
 * 一个随机 UUID 在它那里一律 400。也就是说那段代码在本地全绿、在线上必然
 * 失败——它是「看起来实现了」而不是「实现了」。
 *
 * 改成调 `/object/sign/` 之后：线上由 Supabase 签，本地由 `scripts/db/
 * local-storage.mjs` 那个替身签，两边的 URL 形状、过期语义、token 绑定对象
 * 的行为一致，于是「过期」「换 path 复用失败」这两条在本地就能断言。
 *
 * 代价是这三个端点从此依赖外部服务：存储不可用时它们会 503，而不是返回一个
 * 点不开的链接。这个代价必须付——返回死链比返回错误更难查。
 */

/** 与 Supabase CLI 的默认端口一致，本地栈的网关也在同一 host 上。 */
const DEFAULT_STORAGE_BASE = 'http://127.0.0.1:54321';

/** §8：上传与下载都 ≤5 分钟。 */
export const SIGNED_URL_TTL_SECONDS = 300;

/** 两个 bucket 分开：附件跟合同走，导出跟保留期走，清删策略不同。 */
export const STORAGE_BUCKETS = {
  contracts: 'ops-contracts',
  exports: 'ops-exports',
} as const;

export type StorageBucket = (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

/** 存储侧不可用（连不上、非 2xx、回包缺字段）。路由层翻成 503。 */
export class StorageSignError extends Error {
  constructor(
    message: string,
    readonly detail: { status?: number; bucket: string; key: string },
  ) {
    super(message);
    this.name = 'StorageSignError';
  }
}

/**
 * 把存储回的相对路径拼成绝对地址。
 *
 * 三种回法都要拼对，而且**不能出现 `/storage/v1/storage/v1`**：
 *
 * - `/object/sign/...`（Supabase 的 HTTP 直调，最常见）
 * - `object/sign/...`（少了前导斜杠；拼错会变成 `storage/v1object/...`，
 *   浏览器把它当成端口号后面的一整段路径，表现为 404 而不是报错）
 * - `/storage/v1/object/sign/...`（前面挂了反向代理的实现会带上）
 *
 * 这行代码此前是 `${base}/storage/v1${relative}` 一个模板串，三种里只有
 * 第一种对。第二种与第三种都属于「只有真机才会遇到」，本地替身永远回第一种，
 * 所以它不可能在本地被发现——这也是为什么 C-122 把「前缀」列成待核对项。
 * 与其等核对，不如把三种都接住：多一个分支的代价远小于上线后逐个端点排查。
 */
export function joinStorageUrl(base: string, relative: string): string {
  // 自建实现（MinIO 前置代理、CDN）可能直接回绝对地址，这时候不能再拼 host。
  if (/^https?:\/\//i.test(relative)) return relative;

  const path = relative.startsWith('/') ? relative : `/${relative}`;
  if (path === '/storage/v1' || path.startsWith('/storage/v1/')) return `${base}${path}`;
  return `${base}/storage/v1${path}`;
}

type StorageBindings = ApiEnvironment['Bindings'];

export function storageBaseOf(environment: StorageBindings): string {
  const configured = environment.OPS_STORAGE_PUBLIC_URL;
  return (configured ?? DEFAULT_STORAGE_BASE).replace(/\/+$/, '');
}

/**
 * 路径里的每一段单独编码。
 *
 * 最后一段是用户给的文件名（中文、空格、`#` 都可能有）。整段拼上去不编码，
 * `#` 会把 URL 截断成「对象不存在」；整条 `encodeURIComponent` 又会把 `/`
 * 也编码掉，路径层级没了。按段编码是唯一同时保住层级与字符的做法。
 */
export function encodeStorageKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

interface SignedUrl {
  /** 可直接给前端的绝对地址。 */
  url: string;
  expiresAt: string;
}

/**
 * 签发请求要用 service_role。
 *
 * 上一版这个请求只有 `Content-Type`，一个凭据都不带。本地替身不鉴权，于是
 * 它全绿；而 Supabase 的 `/object/sign/` 在 Kong 之后要求 service_role，
 * 未带凭据一律 401。**这正是「随机 UUID 当签名」的同一类缺陷的第二次**——
 * 本地缺少线上会拒绝的约束。所以现在两端同时收紧：这里带凭据，替身也校验。
 *
 * 缺配置时直接抛，不发一个注定 401 的请求：`storage answered 401` 会让人去
 * 查桶和策略，而真正缺的是一个环境变量。
 */
function storageAuthHeaders(
  environment: StorageBindings,
  bucket: StorageBucket,
  objectKey: string,
): Record<string, string> {
  const serviceKey = environment.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof serviceKey !== 'string' || serviceKey === '') {
    throw new StorageSignError(
      'storage credentials are not configured (SUPABASE_SERVICE_ROLE_KEY is empty)',
      { bucket, key: objectKey },
    );
  }

  // `apikey` 与 `Authorization` 都要：Supabase 的网关先校验前者再看后者，
  // 只带一个的请求在真机上会被拦在网关，而错误是 401，看不出少的是哪个。
  return { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey };
}

/**
 * 向存储要一个签名地址。
 *
 * `mode='upload'` 走 `/object/upload/sign/`，`mode='download'` 走
 * `/object/sign/`——两条路径不对称是 Supabase 的形状，不是笔误。回包字段
 * 也不对称（`url` vs `signedURL`），所以下面按 mode 取字段而不是按「有哪个
 * 用哪个」：后者会在存储改了字段名时安静地取到 undefined。
 */
async function createSignedUrl(
  environment: StorageBindings,
  bucket: StorageBucket,
  key: string,
  mode: 'upload' | 'download',
): Promise<SignedUrl> {
  const base = storageBaseOf(environment);
  const path =
    mode === 'upload'
      ? `/storage/v1/object/upload/sign/${bucket}/${encodeStorageKey(key)}`
      : `/storage/v1/object/sign/${bucket}/${encodeStorageKey(key)}`;

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...storageAuthHeaders(environment, bucket, key),
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    });
  } catch (cause) {
    if (cause instanceof StorageSignError) throw cause;
    throw new StorageSignError(`storage unreachable: ${(cause as Error).message}`, {
      bucket,
      key,
    });
  }

  if (!response.ok) {
    // 404 单独说一句：它几乎总是「bucket 没建」（`ops-exports` 是新建的，
    // 部署时漏建过一次就会是这里），而 `storage answered 404` 这句话让运维
    // 去查对象路径，查半天才发现少了整个 bucket。
    const message =
      response.status === 404
        ? `storage cannot find bucket "${bucket}" or the object in it`
        : `storage answered ${response.status}`;
    throw new StorageSignError(message, { status: response.status, bucket, key });
  }

  const body = (await response.json()) as {
    url?: unknown;
    signedURL?: unknown;
    signedUrl?: unknown;
  };
  // 字段名按 mode 取主线，只在主线缺失时看已知别名：`signedURL` 是 Supabase
  // HTTP 直调的写法，`signedUrl` 是少数代理改写过的写法。两个都认，但都要求
  // 是字符串——「有哪个用哪个」的危险在于取到 undefined 后静默拼出 `undefined`
  // 这种字符串，所以这里先取再验类型，验不过一律抛。
  const candidates = mode === 'upload' ? [body.url] : [body.signedURL, body.signedUrl];
  const relative = candidates.find((value): value is string => typeof value === 'string');

  if (typeof relative !== 'string' || relative === '') {
    throw new StorageSignError('storage response is missing the signed path', { bucket, key });
  }

  return {
    url: joinStorageUrl(base, relative),
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/** 合同附件的上传地址。字段名沿用契约 §5.2 的 `uploadUrl` / `uploadExpiresAt`。 */
export async function createSignedUpload(
  environment: StorageBindings,
  key: string,
  bucket: StorageBucket = STORAGE_BUCKETS.contracts,
): Promise<{ uploadUrl: string; uploadExpiresAt: string }> {
  const signed = await createSignedUrl(environment, bucket, key, 'upload');
  return { uploadUrl: signed.url, uploadExpiresAt: signed.expiresAt };
}

/** 下载地址。bucket 默认合同附件，导出走 `STORAGE_BUCKETS.exports`。 */
export async function createSignedDownload(
  environment: StorageBindings,
  key: string,
  bucket: StorageBucket = STORAGE_BUCKETS.contracts,
): Promise<SignedUrl> {
  return createSignedUrl(environment, bucket, key, 'download');
}

/**
 * 问存储「这个对象在不在」，在就带大小回来。
 *
 * 存在性校验只能由 API 做：数据库不知道 Storage。这个函数就是那句话的落点。
 *
 * 返回 `null` 表示 404（对象确实不在），**不是**错误——「不在」是一个正常
 * 答案，调用方要据此回 409 而不是 503。除此之外的非 2xx 才是真异常。
 */
export async function headStorageObject(
  environment: StorageBindings,
  key: string,
  bucket: StorageBucket = STORAGE_BUCKETS.contracts,
): Promise<{ byteSize: number } | null> {
  const base = storageBaseOf(environment);
  const path = `/storage/v1/object/${bucket}/${encodeStorageKey(key)}`;

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method: 'HEAD',
      headers: storageAuthHeaders(environment, bucket, key),
    });
  } catch (cause) {
    if (cause instanceof StorageSignError) throw cause;
    throw new StorageSignError(`storage unreachable: ${(cause as Error).message}`, {
      bucket,
      key,
    });
  }

  if (response.status === 404) return null;

  if (!response.ok) {
    throw new StorageSignError(`storage answered ${response.status}`, {
      status: response.status,
      bucket,
      key,
    });
  }

  // `Content-Length` 可能缺失（分块响应）；缺失不当作 0，因为 0 会被上层
  // 当成「空文件」而拒掉一个其实正常的对象。
  const length = response.headers.get('content-length');
  return { byteSize: length === null ? Number.NaN : Number(length) };
}
