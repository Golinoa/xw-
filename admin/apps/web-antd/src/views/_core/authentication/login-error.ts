/**
 * 登录失败态归类。
 *
 * 输入是任意抛出物（axios 错误、后端错误体 `{code, status}`、适配层结构化错误），
 * 输出只用于选择页面内联文案，不参与授权判断。
 *
 * 文案口径见 `ops-shell.login.error.*`：
 * - credentials：凭据错误
 * - disabled：账号停用
 * - no-permission：无运营权限（非运营成员 / 无任何动作码）
 * - network：网络或超时
 * - rate-limited：限流
 * - server：服务端异常
 * - unknown：其余
 */

export type LoginErrorKind =
  | 'credentials'
  | 'disabled'
  | 'network'
  | 'no-permission'
  | 'rate-limited'
  | 'server'
  | 'unknown';

const ERROR_MESSAGE_KEYS: Record<LoginErrorKind, string> = {
  credentials: 'ops-shell.login.error.credentials',
  disabled: 'ops-shell.login.error.disabled',
  network: 'ops-shell.login.error.network',
  'no-permission': 'ops-shell.login.error.noPermission',
  'rate-limited': 'ops-shell.login.error.rateLimited',
  server: 'ops-shell.login.error.server',
  unknown: 'ops-shell.login.error.unknown',
};

interface ErrorShape {
  code?: unknown;
  kind?: unknown;
  message?: unknown;
  name?: unknown;
  response?: { data?: { code?: unknown }; status?: unknown };
  status?: unknown;
}

function asShape(error: unknown): ErrorShape {
  return (
    typeof error === 'object' && error !== null ? error : {}
  ) as ErrorShape;
}

function readStatus(error: unknown): number | undefined {
  const shape = asShape(error);
  const status = shape.status ?? shape.response?.status;
  return typeof status === 'number' ? status : undefined;
}

function readCode(error: unknown): string {
  const shape = asShape(error);
  const code = shape.code ?? shape.response?.data?.code;
  return typeof code === 'string' ? code.toLowerCase() : '';
}

const DISABLED_HINTS = ['account_disabled', 'disabled', 'suspended'];
const NO_PERMISSION_HINTS = [
  'forbidden',
  'membership',
  'no_permission',
  'not_operator',
];

/** 登录失败归类。 */
export function classifyLoginError(error: unknown): LoginErrorKind {
  const shape = asShape(error);
  const code = readCode(error);
  const status = readStatus(error);
  const kind = typeof shape.kind === 'string' ? shape.kind : '';
  const message = typeof shape.message === 'string' ? shape.message : '';

  // 账号停用优先于「无权限」，否则会把停用误报成权限问题。
  if (DISABLED_HINTS.some((hint) => code.includes(hint))) {
    return 'disabled';
  }

  if (code === 'auth_required' || code === 'invalid_credentials') {
    return 'credentials';
  }

  if (code === 'rate_limited') {
    return 'rate-limited';
  }

  if (NO_PERMISSION_HINTS.some((hint) => code.includes(hint))) {
    return 'no-permission';
  }

  if (kind === 'network' || shape.name === 'NetworkError') {
    return 'network';
  }

  if (status === undefined) {
    // 无响应：超时、断网、跨域失败都归到这里，便于用户重试。
    return /network|timeout|failed to fetch/i.test(message)
      ? 'network'
      : 'unknown';
  }

  if (status === 0 || status === 408 || status === 504) {
    return 'network';
  }
  if (status === 429) {
    return 'rate-limited';
  }
  if (status === 401) {
    return 'credentials';
  }
  if (status === 403) {
    return 'no-permission';
  }
  if (status >= 500) {
    return 'server';
  }

  return 'unknown';
}

/** 失败类型 → i18n key。 */
export function loginErrorMessageKey(kind: LoginErrorKind): string {
  return ERROR_MESSAGE_KEYS[kind];
}
