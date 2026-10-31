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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    });
  } catch (cause) {
    throw new StorageSignError(`storage unreachable: ${(cause as Error).message}`, {
      bucket,
      key,
    });
  }

  if (!response.ok) {
    throw new StorageSignError(`storage answered ${response.status}`, {
      status: response.status,
      bucket,
      key,
    });
  }

  const body = (await response.json()) as { url?: string; signedURL?: string };
  const relative = mode === 'upload' ? body.url : body.signedURL;
  if (typeof relative !== 'string' || relative === '') {
    throw new StorageSignError('storage response is missing the signed path', { bucket, key });
  }

  // 存储可能回相对路径（Supabase 就是），也可能回绝对 URL（自建实现常见）。
  const url = relative.startsWith('http') ? relative : `${base}/storage/v1${relative}`;

  return {
    url,
    expiresAt: new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/** 合同附件的上传地址。字段名沿用契约 §5.2 的 `uploadUrl` / `uploadExpiresAt`。 */
export async function createSignedUpload(
  environment: StorageBindings,
  key: string,
): Promise<{ uploadUrl: string; uploadExpiresAt: string }> {
  const signed = await createSignedUrl(environment, STORAGE_BUCKETS.contracts, key, 'upload');
  return { uploadUrl: signed.url, uploadExpiresAt: signed.expiresAt };
}

/** 合同附件的下载地址。 */
export async function createSignedDownload(
  environment: StorageBindings,
  key: string,
): Promise<SignedUrl> {
  return createSignedUrl(environment, STORAGE_BUCKETS.contracts, key, 'download');
}
