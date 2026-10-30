#!/usr/bin/env node
/**
 * 依赖漏洞门禁（`a-deps-biz`）。
 *
 * 为什么需要这个脚本，而不是直接把 `pnpm audit` 塞进门禁：
 *
 * `pnpm audit` 只回答「有没有漏洞」，而门禁要回答「这一条能不能放过去」。两者
 * 之间差一份**白名单**，而白名单是有代价的——它一旦没有到期日，就等价于把门禁
 * 删掉，只是删得更隐蔽。所以判定必须由代码来做：
 *
 *   1. critical / high 不在白名单里 → 红；
 *   2. 白名单条目到期了还在告警 → 红（到期即失效，不是「提示续期」）；
 *   3. 白名单条目还在、但依赖已经不告警了 → 红（长期豁免的第一形态就是「没人
 *      再回头看它」）；
 *   4. moderate / low → 只报数量，不阻断。它们的量级决定的是排期，不是「能不能
 *      合入」；把它们一起卡住只会训练人「看到红就重跑」。
 *
 * `--self-test` 用四组合成数据把上面四条各跑一遍：门禁本身也要有证据，否则
 * 「它一直绿」可能只是因为它一直没检查到东西。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const ALLOWLIST_PATH = 'scripts/deps-allowlist.json';
const REGISTRY = 'https://registry.npmjs.org';
const BLOCKING = new Set(['critical', 'high']);

/**
 * 统一两种 audit 输出形状：pnpm 11 给 `advisories`（npm 兼容格式），更早的版本
 * 给 `vulnerabilities`（按包聚合）。只认一种会让「升级 pnpm 之后门禁突然变绿」——
 * 而它其实是没读到数据。
 */
export function normalizeAdvisories(payload) {
  const advisories = [];

  for (const item of Object.values(payload?.advisories ?? {})) {
    advisories.push({
      module: item.module_name,
      severity: item.severity,
      patched: item.patched_versions ?? '',
      title: item.title ?? '',
    });
  }

  for (const item of Object.values(payload?.vulnerabilities ?? {})) {
    const via = Array.isArray(item.via) ? item.via : [];
    const titles = via
      .filter((entry) => typeof entry === 'object' && entry !== null)
      .map((entry) => entry.title ?? '')
      .filter(Boolean);
    advisories.push({
      module: item.name,
      severity: item.severity,
      patched: typeof item.fixAvailable === 'object' ? (item.fixAvailable.version ?? '') : '',
      title: titles[0] ?? '',
    });
  }

  return advisories;
}

/**
 * 纯判定，不碰网络。`today` 显式传入，测试不必靠系统时钟。
 */
export function evaluate(advisories, allowlist, today) {
  const errors = [];
  const warnings = [];
  const entries = allowlist?.entries ?? [];

  for (const entry of entries) {
    if (!entry.module || !entry.reason || !entry.expires) {
      errors.push(`白名单条目不完整（需要 module / reason / expires）：${JSON.stringify(entry)}`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      errors.push(`白名单条目的到期日必须是 YYYY-MM-DD：${entry.module} → ${entry.expires}`);
    }
  }

  const matched = new Set();

  for (const advisory of advisories) {
    if (!BLOCKING.has(advisory.severity)) continue;

    const entry = entries.find((candidate) => candidate.module === advisory.module);

    if (!entry) {
      errors.push(
        `${advisory.severity} ${advisory.module} 不在白名单：${advisory.title || '未提供标题'}` +
          `（修复版 ${advisory.patched || '未知'}）`,
      );
      continue;
    }

    matched.add(entry.module);

    // 字符串比较即可：YYYY-MM-DD 的字典序就是时间序。
    if (entry.expires < today) {
      errors.push(
        `白名单已到期：${entry.module}（${entry.expires}）。到期即失效，不是提示续期——` +
          '要继续豁免必须重新评审并写下新的到期日。',
      );
    } else {
      warnings.push(
        `${advisory.severity} ${advisory.module} 已按白名单放行，到期 ${entry.expires}`,
      );
    }
  }

  for (const entry of entries) {
    if (!entry.module) continue;
    if (!matched.has(entry.module)) {
      errors.push(
        `白名单条目已失效：${entry.module} 当前没有 critical/high 告警。` +
          '长期豁免的第一形态就是「没人再回头看它」，请删除该条目。',
      );
    }
  }

  return { errors, warnings };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runAudit() {
  const result = spawnSync('pnpm', ['audit', '--json', `--registry=${REGISTRY}`], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    maxBuffer: 32 * 1024 * 1024,
  });

  const text = result.stdout?.trim() ?? '';
  if (!text) {
    throw new Error(
      `pnpm audit 没有输出（exit ${result.status}）。离线或 registry 不可用时门禁无法判定，` +
        `按失败处理：${(result.stderr ?? '').split('\n')[0]}`,
    );
  }
  return JSON.parse(text);
}

function selfTest() {
  const cases = [
    {
      name: 'critical 不在白名单 → 红',
      advisories: [
        { module: 'left-pad', severity: 'critical', patched: '>=9.9.9', title: 'synthetic' },
      ],
      allowlist: { entries: [] },
      expectErrors: 1,
    },
    {
      name: 'high 在白名单且未到期 → 放行',
      advisories: [
        { module: 'left-pad', severity: 'high', patched: '>=9.9.9', title: 'synthetic' },
      ],
      allowlist: {
        entries: [{ module: 'left-pad', reason: 'synthetic', expires: '2099-01-01' }],
      },
      expectErrors: 0,
    },
    {
      name: 'high 在白名单但已到期 → 红',
      advisories: [
        { module: 'left-pad', severity: 'high', patched: '>=9.9.9', title: 'synthetic' },
      ],
      allowlist: {
        entries: [{ module: 'left-pad', reason: 'synthetic', expires: '2020-01-01' }],
      },
      expectErrors: 1,
    },
    {
      name: 'moderate 不在白名单 → 只计数不阻断',
      advisories: [
        { module: 'left-pad', severity: 'moderate', patched: '>=9.9.9', title: 'synthetic' },
      ],
      allowlist: { entries: [] },
      expectErrors: 0,
    },
    {
      name: '白名单条目已失效（依赖不告警了）→ 红',
      advisories: [],
      allowlist: {
        entries: [{ module: 'left-pad', reason: 'synthetic', expires: '2099-01-01' }],
      },
      expectErrors: 1,
    },
  ];

  for (const testCase of cases) {
    const { errors } = evaluate(testCase.advisories, testCase.allowlist, '2026-10-30');
    const ok = errors.length === testCase.expectErrors;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${testCase.name}（errors=${errors.length}）`);
    if (!ok) {
      console.error(errors.join('\n'));
      return 1;
    }
  }
  return 0;
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--self-test')) return selfTest();

  if (!existsSync(ALLOWLIST_PATH)) {
    console.error(`缺少 ${ALLOWLIST_PATH}：没有白名单文件时无法区分「没有漏洞」与「没查」。`);
    return 1;
  }

  const allowlist = readJson(ALLOWLIST_PATH);
  const inputIndex = argv.indexOf('--input');
  const payload = inputIndex >= 0 ? readJson(argv[inputIndex + 1]) : runAudit();

  const advisories = normalizeAdvisories(payload);
  const counts = advisories.reduce((acc, advisory) => {
    acc[advisory.severity] = (acc[advisory.severity] ?? 0) + 1;
    return acc;
  }, {});

  const today = new Date().toISOString().slice(0, 10);
  const { errors, warnings } = evaluate(advisories, allowlist, today);

  for (const warning of warnings) console.log(`warn ${warning}`);

  const summary = ['critical', 'high', 'moderate', 'low', 'info']
    .map((severity) => `${severity} ${counts[severity] ?? 0}`)
    .join(' / ');

  if (errors.length > 0) {
    console.error('依赖漏洞门禁未通过：');
    for (const error of errors) console.error(`- ${error}`);
    console.error(`\n当前告警：${summary}`);
    return 1;
  }

  console.log(`依赖漏洞门禁通过 — 告警 ${summary}，白名单 ${allowlist.entries?.length ?? 0} 条`);
  return 0;
}

process.exit(main());
