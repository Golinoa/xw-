import { describe, expect, it } from 'vitest';

// 直接从模块文件导入，不经 `identity/index.ts`：
// index 会连带 `session.ts → request.ts → env.ts`，而 `env.ts` 在模块求值时
// 校验 `import.meta.env`，会把一个纯函数的单测拖成环境配置测试。
import {
  checkContractCompatibility,
  OPS_CONTRACT_VERSION,
  parseContractVersion,
} from '#/api/ops/identity/contract-version';

/**
 * 契约版本兼容判定（契约 §2.1、§8）。
 *
 * 这些用例固定的是「什么情况下允许进业务页」这条边界。它一旦放松，症状是
 * 页面能打开但字段莫名 undefined——比直接报错难排查得多，所以每条拒绝路径
 * 都要有用例。
 */
describe('parseContractVersion', () => {
  it('解析完整三段版本', () => {
    expect(parseContractVersion('1.4.2')).toEqual({
      major: 1,
      minor: 4,
      patch: 2,
    });
  });

  it('缺省 patch 段按 0 补齐', () => {
    expect(parseContractVersion('2.1')).toEqual({
      major: 2,
      minor: 1,
      patch: 0,
    });
  });

  it('忽略首尾空白（后端可能带换行）', () => {
    expect(parseContractVersion(' 1.0.0 ')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
    });
  });

  it('接受 semver 预发布与构建后缀（桩用 1.0.0-stub 标明不是真后端）', () => {
    expect(parseContractVersion('1.0.0-stub')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
    });
    expect(parseContractVersion('1.2.3-rc.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
    expect(parseContractVersion('1.2.3+build.9')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it.each([
    ['空字符串', ''],
    ['非字符串', 1],
    ['null', null],
    ['undefined', undefined],
    ['带 v 前缀', 'v1.0.0'],
    ['带范围符', '^1.0.0'],
    ['只有主版本', '1'],
    ['段数过多', '1.0.0.0'],
    ['非数字', 'a.b.c'],
    ['后缀为空', '1.0.0-'],
  ])('拒绝非法输入：%s', (_label, input) => {
    expect(parseContractVersion(input)).toBeNull();
  });
});

describe('checkContractCompatibility', () => {
  it('版本完全一致时兼容', () => {
    const verdict = checkContractCompatibility('1.0.0', '1.0.0');
    expect(verdict.compatible).toBe(true);
    expect(verdict.actual).toBe('1.0.0');
    expect(verdict.expected).toBe('1.0.0');
  });

  it('major 相同、minor/patch 不同时仍兼容（契约加法演进）', () => {
    expect(checkContractCompatibility('1.9.7', '1.0.0').compatible).toBe(true);
    expect(checkContractCompatibility('1.0.0', '1.9.7').compatible).toBe(true);
  });

  it('major 不同时拒绝，并给出 MAJOR_MISMATCH', () => {
    expect(checkContractCompatibility('2.0.0', '1.0.0')).toMatchObject({
      compatible: false,
      reason: 'MAJOR_MISMATCH',
    });
  });

  it('后端返回非法版本时拒绝，而不是当作兼容', () => {
    expect(checkContractCompatibility('', '1.0.0')).toMatchObject({
      compatible: false,
      reason: 'MALFORMED',
    });
  });

  it('后端返回 null 时拒绝（半成品 /meta 不得静默放行）', () => {
    expect(checkContractCompatibility(null, '1.0.0').compatible).toBe(false);
  });

  it('期望值本身非法时也拒绝（常量写错属于构建期缺陷）', () => {
    expect(checkContractCompatibility('1.0.0', 'wrong')).toMatchObject({
      compatible: false,
      reason: 'MALFORMED',
    });
  });

  it('默认期望值取自 OPS_CONTRACT_VERSION', () => {
    const verdict = checkContractCompatibility(OPS_CONTRACT_VERSION);
    expect(verdict.compatible).toBe(true);
    expect(verdict.expected).toBe(OPS_CONTRACT_VERSION);
  });

  it('默认常量本身必须是合法版本（防手滑改坏）', () => {
    expect(parseContractVersion(OPS_CONTRACT_VERSION)).not.toBeNull();
  });

  it('开发态桩的版本必须与前端常量兼容', async () => {
    // 桩用 `1.0.0-stub` 标明「不是真后端」。若它被改成不兼容的 MAJOR，
    // 整条 e2e 会被自己的版本门挡在登录页外面，而报错看起来像是登录失败。
    // 这条用例把「桩版本」和「门禁」钉在一起，改任一边立刻有反馈。
    const { STUB_CONTRACT_VERSION } = await import('../ops/__stub__/fixtures');
    expect(checkContractCompatibility(STUB_CONTRACT_VERSION).compatible).toBe(
      true,
    );
  });

  it('带后缀也不能掩盖 MAJOR 不同', () => {
    expect(checkContractCompatibility('2.0.0-rc1', '1.0.0')).toMatchObject({
      compatible: false,
      reason: 'MAJOR_MISMATCH',
    });
  });
});
