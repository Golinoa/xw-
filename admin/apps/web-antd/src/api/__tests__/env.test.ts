import { describe, expect, it } from 'vitest';

import {
  assertApiBaseUrl,
  assertNoServerSecrets,
  OpsEnvError,
  parseBooleanFlag,
  resolveOpsEnv,
} from '../adapter/env';

describe('assertApiBaseUrl', () => {
  it('接受同源相对路径并去掉尾部斜杠', () => {
    expect(assertApiBaseUrl('/api')).toBe('/api');
    expect(assertApiBaseUrl('/api/')).toBe('/api');
    expect(assertApiBaseUrl('  /gateway/api  ')).toBe('/gateway/api');
  });

  it('未配置时抛错，不静默回退', () => {
    expect(() => assertApiBaseUrl('')).toThrow(OpsEnvError);
    expect(() => assertApiBaseUrl(undefined)).toThrow(/未配置/);
  });

  it('拒绝协议相对地址与凭据', () => {
    expect(() => assertApiBaseUrl('//evil.example.com/api')).toThrow(
      /协议相对地址/,
    );
    // 这里的 `user:pass` 是待拒绝的输入，不是凭据：本用例断言带 userinfo 的
    // baseURL 必须抛错。只抑制这一行的 BasicAuth 规则，不忽略整个文件——
    // 文件级 ignore 会把同文件其余用例的漏检一并吞掉。
    expect(() =>
      // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- 待拒绝的输入
      assertApiBaseUrl('https://user:pass@ops.example.com/api'),
    ).toThrow(/不得包含用户名或密码/);
  });

  it('拒绝非白名单跨源地址', () => {
    expect(() =>
      assertApiBaseUrl('https://api.example.com/api', { allowedOrigins: [] }),
    ).toThrow(/白名单/);
  });

  it('白名单内的 https 地址可用', () => {
    expect(
      assertApiBaseUrl('https://ops.example.com/api/', {
        allowedOrigins: ['https://ops.example.com'],
      }),
    ).toBe('https://ops.example.com/api');
  });

  it('明文 http 只允许本机开发', () => {
    expect(() =>
      assertApiBaseUrl('http://ops.example.com/api', {
        allowInsecureLocalhost: true,
        allowedOrigins: ['http://ops.example.com'],
      }),
    ).toThrow(/禁止使用明文 http/);

    expect(
      assertApiBaseUrl('http://localhost:5320/api', {
        allowInsecureLocalhost: true,
        allowedOrigins: ['http://localhost:5320'],
      }),
    ).toBe('http://localhost:5320/api');

    expect(() =>
      assertApiBaseUrl('http://localhost:5320/api', {
        allowInsecureLocalhost: false,
        allowedOrigins: ['http://localhost:5320'],
      }),
    ).toThrow(/禁止使用明文 http/);
  });

  it('拒绝带查询串的地址', () => {
    expect(() => assertApiBaseUrl('/api?debug=1')).toThrow(/查询串/);
  });
});

describe('parseBooleanFlag', () => {
  it('只接受 true/false', () => {
    expect(parseBooleanFlag('VITE_OPS_MOCK', 'true')).toBe(true);
    expect(parseBooleanFlag('VITE_OPS_MOCK', 'TRUE')).toBe(true);
    expect(parseBooleanFlag('VITE_OPS_MOCK', 'false')).toBe(false);
    expect(parseBooleanFlag('VITE_OPS_MOCK', '')).toBe(false);
    expect(parseBooleanFlag('VITE_OPS_MOCK', undefined)).toBe(false);
    expect(() => parseBooleanFlag('VITE_OPS_MOCK', 'yes')).toThrow(OpsEnvError);
  });
});

describe('assertNoServerSecrets', () => {
  it('拦截 VITE_ 前缀的服务端密钥变量', () => {
    const key = ['VITE', 'SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');
    expect(() => assertNoServerSecrets({ [key]: 'x' })).toThrow(
      /疑似服务端密钥/,
    );
  });

  it('允许非 VITE_ 前缀的同名变量（不进前端包）', () => {
    const key = ['SUPABASE', 'SERVICE', 'ROLE', 'KEY'].join('_');
    expect(() => assertNoServerSecrets({ [key]: 'x' })).not.toThrow();
  });

  it('拦截内联 PEM 私钥', () => {
    expect(() =>
      assertNoServerSecrets({
        VITE_NOTE: ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
      }),
    ).toThrow(/PEM 私钥/);
  });
});

describe('resolveOpsEnv', () => {
  const baseSource = {
    VITE_GLOB_API_URL: '/api',
    VITE_NITRO_MOCK: 'false',
    VITE_OPS_MOCK: 'false',
  };

  it('解析出同源基地址与运营前缀', () => {
    const env = resolveOpsEnv(baseSource);
    expect(env.apiBaseUrl).toBe('/api');
    expect(env.opsApiPrefix).toBe('/v1/ops');
    expect(env.mockEnabled).toBe(false);
    expect(env.isProduction).toBe(false);
  });

  it('生产构建禁止启用契约桩', () => {
    expect(() =>
      resolveOpsEnv({
        ...baseSource,
        MODE: 'production',
        VITE_OPS_MOCK: 'true',
      }),
    ).toThrow(/生产构建禁止启用开发态契约桩/);
  });

  it('生产构建禁止启用 nitro mock', () => {
    expect(() =>
      resolveOpsEnv({
        ...baseSource,
        MODE: 'production',
        VITE_NITRO_MOCK: 'true',
      }),
    ).toThrow(/生产构建禁止启用 nitro mock/);
  });

  it('基地址不得重复包含运营命名空间', () => {
    expect(() =>
      resolveOpsEnv({ ...baseSource, VITE_GLOB_API_URL: '/api/v1/ops' }),
    ).toThrow(/不应包含运营命名空间/);
  });
});
