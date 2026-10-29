/**
 * 运营后台运行环境校验。
 *
 * 设计约束（`admin/.harness/docs/design-docs/2026-10-29-ops-shell-design.md` §2.1.2、§2.1.3）：
 * 1. API 基地址必须是**同源相对路径**（如 `/api`），或 `VITE_OPS_API_ALLOWED_ORIGINS` 白名单内的绝对地址；
 * 2. 非法配置在启动时抛出可读错误，**不允许静默回退**到 mock 或空地址；
 * 3. 生产构建禁止启用任何 mock，也禁止把服务端密钥类变量打进前端包。
 *
 * 运营命名空间固定为 `/api/v1/ops`（`Docs/ops-api-contract.md` §2.1），
 * 因此 `apiBaseUrl` 只承载「源 + 通用前缀」，端点一律基于 `opsApiPrefix` 拼接。
 */

/** 运营 API 命名空间，相对 `apiBaseUrl`。改名只需改这一处。 */
export const DEFAULT_OPS_API_PREFIX = '/v1/ops';

/** 允许存在但必须为空的变量名片段（命中即视为密钥泄漏）。 */
const FORBIDDEN_ENV_KEY_FRAGMENTS = [
  'service_role',
  'service-role',
  'private_key',
  'secret_key',
  'client_secret',
  'access_key',
  'signing_key',
];

/** 变量值疑似 PEM 私钥，直接拒绝。 */
const PEM_PRIVATE_KEY_PATTERN = /-{5}BEGIN[A-Z ]*PRIVATE KEY-{5}/;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

export interface OpsEnvSource {
  [key: string]: unknown;
}

export interface OpsRuntimeEnv {
  /** axios baseURL，例如 `/api` 或白名单内的 `https://ops.example.com/api`。 */
  readonly apiBaseUrl: string;
  /** 运营命名空间前缀，例如 `/v1/ops`。 */
  readonly opsApiPrefix: string;
  /** 是否启用开发态契约桩（`VITE_OPS_MOCK`）。 */
  readonly mockEnabled: boolean;
  /** 是否启用 nitro mock（`VITE_NITRO_MOCK`），生产必须为 false。 */
  readonly nitroMockEnabled: boolean;
  readonly isProduction: boolean;
}

/** 环境配置错误。消息必须能直接呈现给开发者，包含变量名与修复方向。 */
export class OpsEnvError extends Error {
  public readonly variable: string;

  constructor(variable: string, detail: string) {
    super(`[ops-env] ${variable} ${detail}`);
    this.name = 'OpsEnvError';
    this.variable = variable;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: OpsEnvSource, key: string): string {
  const raw = source[key];
  if (raw === undefined || raw === null) {
    return '';
  }
  if (typeof raw !== 'string') {
    throw new OpsEnvError(key, `必须是字符串，实际为 ${typeof raw}`);
  }
  return raw.trim();
}

/**
 * 布尔开关只接受 `true` / `false`（大小写不敏感）。
 * 其它值一律报错——把 `VITE_OPS_MOCK=yes` 静默当成 false 会让"桩是否启用"变成猜测。
 */
export function parseBooleanFlag(variable: string, raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') {
    return false;
  }
  if (typeof raw === 'boolean') {
    return raw;
  }
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new OpsEnvError(variable, `只接受 true/false，实际为 "${String(raw)}"`);
}

function normalizePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '' : trimmed;
}

function readAllowedOrigins(source: OpsEnvSource): string[] {
  const raw = readString(source, 'VITE_OPS_API_ALLOWED_ORIGINS');
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
    .map((item) => {
      try {
        return new URL(item).origin;
      } catch {
        throw new OpsEnvError(
          'VITE_OPS_API_ALLOWED_ORIGINS',
          `包含非法地址 "${item}"，必须写完整来源（如 https://ops.example.com）`,
        );
      }
    });
}

/**
 * 校验并归一化 API 基地址。
 *
 * 允许：
 * - `/api`（同源相对路径，推荐）；
 * - 白名单内 `https://host[:port]/base`；
 * - 仅开发态允许白名单内 `http://localhost|127.0.0.1|[::1][:port]`。
 */
export function assertApiBaseUrl(
  raw: unknown,
  options: {
    allowedOrigins?: string[];
    allowInsecureLocalhost?: boolean;
    variable?: string;
  } = {},
): string {
  const variable = options.variable ?? 'VITE_GLOB_API_URL';
  const value = typeof raw === 'string' ? raw.trim() : '';

  if (value === '') {
    throw new OpsEnvError(
      variable,
      '未配置。必须显式配置同源相对路径（如 /api），不允许默认值或回退到 mock',
    );
  }

  if (value.startsWith('//')) {
    throw new OpsEnvError(
      variable,
      `不允许协议相对地址 "${value}"，请写成 /api 或完整 https 地址`,
    );
  }

  if (value.startsWith('/')) {
    const pathname = normalizePathname(value);
    if (pathname.includes('?') || pathname.includes('#')) {
      throw new OpsEnvError(variable, '不允许包含查询串或 hash');
    }
    return pathname;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new OpsEnvError(
      variable,
      `不是合法的绝对地址 "${value}"。同源部署请使用 /api`,
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new OpsEnvError(
      variable,
      `只支持 http/https，实际为 ${parsed.protocol}`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new OpsEnvError(variable, '地址中不得包含用户名或密码');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new OpsEnvError(variable, '地址中不得包含查询串或 hash');
  }
  if (parsed.protocol === 'http:') {
    const isLoopback = LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
    if (!(options.allowInsecureLocalhost === true && isLoopback)) {
      throw new OpsEnvError(
        variable,
        `非本机地址禁止使用明文 http："${value}"，请改用 https（同源部署请使用 /api）`,
      );
    }
  }

  const allowedOrigins = options.allowedOrigins ?? [];
  if (!allowedOrigins.includes(parsed.origin)) {
    throw new OpsEnvError(
      variable,
      `跨源地址 "${parsed.origin}" 不在 VITE_OPS_API_ALLOWED_ORIGINS 白名单内。` +
        '运营后台按同源部署决策，跨源必须显式登记来源',
    );
  }

  const pathname = normalizePathname(parsed.pathname);
  return `${parsed.origin}${pathname}`;
}

/**
 * 禁止服务端密钥进入前端构建产物。
 *
 * 只看 `VITE_` 前缀变量：非 `VITE_` 变量不会进入 bundle，但一旦误写成 `VITE_SUPABASE_SERVICE_ROLE_KEY`
 * 就会打进产物，所以必须在这里拦下。
 */
export function assertNoServerSecrets(source: OpsEnvSource): void {
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('VITE_')) {
      continue;
    }
    const lowerKey = key.toLowerCase();
    const hit = FORBIDDEN_ENV_KEY_FRAGMENTS.find((fragment) =>
      lowerKey.includes(fragment),
    );
    if (hit) {
      throw new OpsEnvError(
        key,
        `疑似服务端密钥（命中 "${hit}"）。前端只允许公开配置，服务端密钥必须留在 Worker secrets`,
      );
    }
    if (typeof value === 'string' && PEM_PRIVATE_KEY_PATTERN.test(value)) {
      throw new OpsEnvError(key, '值疑似 PEM 私钥，禁止进入前端构建产物');
    }
  }
}

function readDefaultSource(): OpsEnvSource {
  // 生产构建会把 `VITE_GLOB_*` 抽到 `_app.config.js` 并在运行时注入 window，
  // 因此运行时配置优先于构建期常量（与 `@vben/hooks` 的 useAppConfig 行为一致）。
  const injected = (globalThis as Record<string, unknown>)
    ._VBEN_ADMIN_PRO_APP_CONF_;
  const runtime = isRecord(injected) ? injected : {};
  return { ...(import.meta.env as OpsEnvSource), ...runtime };
}

/** 纯函数版本，便于单测直接注入"环境变量表"。 */
export function resolveOpsEnv(
  source: OpsEnvSource = readDefaultSource(),
): OpsRuntimeEnv {
  const isProduction =
    source.PROD === true ||
    source.PROD === 'true' ||
    String(source.MODE ?? '') === 'production';

  assertNoServerSecrets(source);

  const opsApiPrefix =
    readString(source, 'VITE_OPS_API_PREFIX') || DEFAULT_OPS_API_PREFIX;
  const apiBaseUrl = assertApiBaseUrl(source.VITE_GLOB_API_URL, {
    allowInsecureLocalhost: !isProduction,
    allowedOrigins: readAllowedOrigins(source),
  });

  if (
    opsApiPrefix !== '' &&
    apiBaseUrl.endsWith(normalizePathname(opsApiPrefix))
  ) {
    throw new OpsEnvError(
      'VITE_GLOB_API_URL',
      `不应包含运营命名空间 "${opsApiPrefix}"。该前缀由 VITE_OPS_API_PREFIX 单独维护，` +
        '否则端点路径会重复拼接',
    );
  }

  const mockEnabled = parseBooleanFlag('VITE_OPS_MOCK', source.VITE_OPS_MOCK);
  const nitroMockEnabled = parseBooleanFlag(
    'VITE_NITRO_MOCK',
    source.VITE_NITRO_MOCK,
  );

  if (isProduction && mockEnabled) {
    throw new OpsEnvError(
      'VITE_OPS_MOCK',
      '生产构建禁止启用开发态契约桩（桩数据不是真实集成）',
    );
  }
  if (isProduction && nitroMockEnabled) {
    throw new OpsEnvError('VITE_NITRO_MOCK', '生产构建禁止启用 nitro mock');
  }

  return Object.freeze({
    apiBaseUrl,
    isProduction,
    mockEnabled,
    nitroMockEnabled,
    opsApiPrefix: normalizePathname(opsApiPrefix),
  });
}

let cachedEnv: OpsRuntimeEnv | undefined;

/**
 * 进程内唯一的运行时环境。`request.ts` 在模块初始化时调用它，
 * 使非法配置在应用启动阶段（挂载前）就抛错，而不是等到第一次请求。
 */
export function getOpsEnv(): OpsRuntimeEnv {
  cachedEnv ??= resolveOpsEnv();
  return cachedEnv;
}

/** 仅供单测：清空缓存以重新校验另一套环境变量。 */
export function resetOpsEnvCache(): void {
  cachedEnv = undefined;
}
