#!/usr/bin/env node
/**
 * 依赖漏洞门禁（C-99 / D-11）。
 *
 * 原来这一步是 `pnpm audit --audit-level high`，直接把退出码当结论。它答不了
 * 门禁真正要答的那一问——「这一条能不能放过去」。两个反例：
 *
 *   - 有一条 advisory 上游根本没有修复版（patched 写成 `<0.0.0`），裸退出码永远
 *     是 1，于是这道门永远红；红久了就没人看，等于没有门。
 *   - 反过来，把 `--audit-level` 降成 moderate 甚至删掉这一步，会把「能修但没人
 *     修」的一起放过去——**裸退出码分不清这两种情况**。
 *
 * 所以判定必须由代码来做，并且分两层：
 *
 *   第一层「够不够得着」（口径 2：按生产依赖分级）。只有进了上线产物的依赖才
 *   阻断。判据不是 `pnpm audit --prod` —— 那不是这个意思：monorepo 里
 *   `@vben/vite-config` 把 nitropack 写在 `dependencies` 里（它对它是运行期依赖，
 *   对上线产物不是），于是 `--prod` 仍把 node-forge 报出来。真正的判据是
 *   **`@vben/web-antd` 的生产依赖可达集**（本仓唯一上线的应用，`build:antd`）。
 *   不在这个集合里的 critical/high 只计数、不阻断，但每次运行都会打印出来。
 *
 *   第二层「要不要豁免」（口径 3：白名单 + 到期日）。够得着的 critical/high 想
 *   通过，必须有一条白名单条目，而且：
 *
 *     1. 条目到期了还在告警 → 红（到期即失效，不是「提示续期」）；
 *     2. 条目还在、依赖已经不告警了 → 红（长期豁免的第一形态就是「没人再回头
 *        看它」）；
 *     3. 条目本身不完整 / 到期日不是 YYYY-MM-DD → 红。
 *
 *   moderate / low 只报数量：它们的量级决定的是排期，不是「能不能合入」；一起
 *   卡住只会训练人「看到红就重跑」。
 *
 * `--self-test` 用合成数据把上面每一条各跑一遍。门禁本身也要有证据——否则
 * 「它一直绿」可能只是因为它一直没检查到东西。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const ALLOWLIST_PATH = 'scripts/deps-allowlist.json';
const REGISTRY = 'https://registry.npmjs.org';
/** 唯一打进上线产物的应用。换/加应用要同步改这里，否则分类会静默变宽。 */
const SHIPPED_APP = '@vben/web-antd';
const BLOCKING = new Set(['critical', 'high']);
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

/**
 * 统一两种 audit 输出形状：pnpm 11 起给 `advisories`（npm 兼容格式），更早的
 * 版本给 `vulnerabilities`（按包聚合）。只认一种会让「升级 pnpm 之后门禁突然
 * 变绿」——而它其实是没读到数据。
 */
export function normalizeAdvisories(payload) {
  const advisories = [];

  for (const item of Object.values(payload?.advisories ?? {})) {
    advisories.push({
      id: item.github_advisory_id ?? `npm:${item.module_name}`,
      module: item.module_name,
      severity: item.severity ?? 'unknown',
      patched: item.patched_versions ?? '',
      title: item.title ?? '',
      versions: (item.findings ?? [])
        .map((finding) => finding.version)
        .filter(Boolean),
    });
  }

  for (const item of Object.values(payload?.vulnerabilities ?? {})) {
    const via = Array.isArray(item.via) ? item.via : [];
    const detail = via.find(
      (entry) => typeof entry === 'object' && entry !== null,
    );
    advisories.push({
      id: detail?.source ? `npm:${detail.source}` : `npm:${item.name}`,
      module: item.name,
      severity: item.severity ?? 'unknown',
      patched:
        typeof item.fixAvailable === 'object'
          ? (item.fixAvailable.version ?? '')
          : '',
      title: detail?.title ?? '',
      versions: [],
    });
  }

  return advisories;
}

/**
 * 从 `pnpm list --prod --depth 99 --json` 的输出里摊平出包名集合。
 * 只走 `dependencies`：`--prod` 已经把 devDependencies 摘掉了，但 workspace
 * 项目的 `dependencies` 里可能有别人当工具用的包（见文件头），所以这个集合是
 * **保守的上界**——宁可多算成「够得着」，也不要漏。
 */
export function flattenProdGraph(json) {
  const names = new Set();

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node.name === 'string') names.add(node.name);
    for (const [key, value] of Object.entries(node)) {
      if (key === 'dependencies' || key === 'optionalDependencies') {
        for (const [depName, dep] of Object.entries(value ?? {})) {
          names.add(depName);
          walk(dep);
        }
      }
    }
  };

  walk(json);
  return names;
}

/**
 * 纯判定，不碰网络也不读时钟：`today` 与 `prod` 显式传入，测试不必靠环境。
 */
export function evaluate({ advisories, allowlist, prod, today }) {
  const errors = [];
  const warnings = [];
  const counted = { blocking: {}, dev: {} };
  const entries = allowlist?.entries ?? [];

  const bump = (bucket, severity) => {
    bucket[severity] = (bucket[severity] ?? 0) + 1;
  };

  for (const entry of entries) {
    const missing = ['advisory', 'module', 'reason', 'expires', 'owner'].filter(
      (field) => !entry?.[field],
    );
    if (missing.length > 0) {
      errors.push(
        `白名单条目不完整（缺 ${missing.join(' / ')}）：${JSON.stringify(entry)}`,
      );
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      errors.push(
        `白名单条目的到期日必须是 YYYY-MM-DD：${entry.module} → ${entry.expires}`,
      );
    }
  }

  const matched = new Set();

  for (const advisory of advisories) {
    const reachable = prod.has(advisory.module);
    const severity = advisory.severity;
    const entry = entries.find(
      (candidate) => candidate?.advisory === advisory.id,
    );

    if (!BLOCKING.has(severity)) {
      bump(reachable ? counted.blocking : counted.dev, severity);
      continue;
    }

    if (!reachable) {
      bump(counted.dev, severity);
      if (entry) matched.add(entry.advisory);
      warnings.push(
        `dev ${severity} ${advisory.module}（${advisory.id}）不进上线产物，只计数不阻断` +
          `${advisory.patched ? `；修复版 ${advisory.patched}` : ''}`,
      );
      continue;
    }

    bump(counted.blocking, severity);

    if (!entry) {
      errors.push(
        `${severity} ${advisory.module} 在生产依赖里且不在白名单：${advisory.title || '未提供标题'}` +
          `（${advisory.id}；修复版 ${advisory.patched || '未知'}）`,
      );
      continue;
    }

    matched.add(entry.advisory);

    // 字符串比较即可：YYYY-MM-DD 的字典序就是时间序。
    if (entry.expires < today) {
      errors.push(
        `白名单已到期：${advisory.module}（${advisory.id}，${entry.expires}）。` +
          '到期即失效，不是提示续期——要继续豁免必须重新评审并写下新的到期日。',
      );
    } else {
      warnings.push(
        `${severity} ${advisory.module} 已按白名单放行，到期 ${entry.expires}（${entry.owner}）`,
      );
    }
  }

  for (const entry of entries) {
    if (!entry?.advisory || matched.has(entry.advisory)) continue;
    errors.push(
      `白名单条目已失效：${entry.advisory}（${entry.module}）当前没有对应的 critical/high 告警。` +
        '长期豁免的第一形态就是「没人再回头看它」，请删除该条目。',
    );
  }

  return { counted, errors, warnings };
}

function summarize(counts) {
  return SEVERITY_ORDER.map(
    (severity) => `${severity} ${counts[severity] ?? 0}`,
  ).join(' / ');
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runPnpm(args) {
  return spawnSync('pnpm', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
}

function runAudit() {
  const result = runPnpm(['audit', '--json', `--registry=${REGISTRY}`]);
  const text = result.stdout?.trim() ?? '';
  if (!text) {
    throw new Error(
      `pnpm audit 没有输出（exit ${result.status}）。离线或 registry 不可用时门禁无法判定，` +
        `按失败处理：${(result.stderr ?? '').split('\n')[0]}`,
    );
  }
  return JSON.parse(text);
}

function runProdGraph() {
  const result = runPnpm([
    '--filter',
    SHIPPED_APP,
    'list',
    '--prod',
    '--depth',
    '99',
    '--json',
  ]);
  const text = result.stdout?.trim() ?? '';
  if (!text) {
    throw new Error(
      `拿不到 ${SHIPPED_APP} 的生产依赖图（exit ${result.status}）：` +
        `${(result.stderr ?? '').split('\n')[0]}。没有它就无法分级，按失败处理。`,
    );
  }
  return JSON.parse(text);
}

/**
 * 空图必须炸，而且**两条入口都要炸**。第一版只在 `runProdGraph()` 里挡，`--graph`
 * 传进来的空数组绕过了检查——变异第五枪就是这么绿的（空图 → 一切都算 dev → 全绿）。
 * 分类轴的失效方式是「静默变宽」，不是报错，所以这道断言比它看起来重要。
 */
function loadProdGraph(json) {
  const names = flattenProdGraph(json);
  if (names.size === 0) {
    throw new Error('生产依赖图为空——分类会静默把一切都当成 dev，按失败处理。');
  }
  return names;
}

function selfTest() {
  const prod = new Set(['left-pad', 'zod']);
  const base = {
    advisory: 'GHSA-aaaa-bbbb-cccc',
    module: 'left-pad',
    reason: '合成用例：上游无修复版',
    expires: '2099-01-01',
    owner: 'self-test',
  };
  const high = {
    id: 'GHSA-aaaa-bbbb-cccc',
    module: 'left-pad',
    severity: 'high',
    patched: '>=9',
    title: 'synthetic',
    versions: [],
  };

  const cases = [
    {
      name: '生产依赖里的 high 不在白名单 → 红',
      advisories: [high],
      allowlist: { entries: [] },
      expectErrors: 1,
    },
    {
      name: '生产依赖里的 high 在白名单且未到期 → 放行',
      advisories: [high],
      allowlist: { entries: [{ ...base }] },
      expectErrors: 0,
    },
    {
      name: '白名单条目已到期 → 红',
      advisories: [high],
      allowlist: { entries: [{ ...base, expires: '2020-01-01' }] },
      expectErrors: 1,
    },
    {
      name: '开发期依赖的 high 不在白名单 → 只计数不阻断',
      advisories: [{ ...high, module: 'minimatch', id: 'GHSA-dddd-eeee-ffff' }],
      allowlist: { entries: [] },
      expectErrors: 0,
    },
    {
      name: '白名单条目已失效（依赖不告警了）→ 红',
      advisories: [],
      allowlist: { entries: [{ ...base }] },
      expectErrors: 1,
    },
    {
      name: 'moderate 不进白名单也不阻断',
      advisories: [{ ...high, severity: 'moderate' }],
      allowlist: { entries: [] },
      expectErrors: 0,
    },
    {
      // 只有一条错：条目校验红。advisory 仍能按 advisory id 匹配上条目，所以
      // 不会再叠一条「不在白名单」——这里第一次写成了 2，是自检先发现我算错。
      name: '条目缺 owner → 红',
      advisories: [high],
      allowlist: { entries: [{ ...base, owner: '' }] },
      expectErrors: 1,
    },
    {
      name: '到期日不是 YYYY-MM-DD → 红',
      advisories: [high],
      allowlist: { entries: [{ ...base, expires: '2027/01/28' }] },
      expectErrors: 1,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const { errors } = evaluate({ ...testCase, prod, today: '2026-10-31' });
    const ok = errors.length === testCase.expectErrors;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${testCase.name}（errors=${errors.length}）`,
    );
    if (!ok) {
      failed += 1;
      for (const error of errors) console.error(`      ${error}`);
    }
  }

  // 两种输出形状都要读得出东西：读不出就等于门禁空转。
  const shapes = [
    [
      'pnpm advisories 形状',
      {
        advisories: {
          1: {
            module_name: 'x',
            severity: 'high',
            github_advisory_id: 'GHSA-x',
          },
        },
      },
    ],
    [
      'npm vulnerabilities 形状',
      {
        vulnerabilities: {
          x: {
            name: 'x',
            severity: 'high',
            via: [{ title: 't' }],
            fixAvailable: { version: '9' },
          },
        },
      },
    ],
  ];
  for (const [label, payload] of shapes) {
    const ok = normalizeAdvisories(payload).length === 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}解析出一条`);
    if (!ok) failed += 1;
  }

  // 空图必须炸：分类轴的失效方式是「静默变宽」——所有东西都被算成 dev，门禁全绿。
  let emptyThrew = false;
  try {
    loadProdGraph([]);
  } catch {
    emptyThrew = true;
  }
  console.log(
    `${emptyThrew ? 'ok  ' : 'FAIL'} 空的生产依赖图直接报错，不静默放行`,
  );
  if (!emptyThrew) failed += 1;

  return failed === 0 ? 0 : 1;
}

/**
 * 门禁失败要像门禁，不像崩溃：抛异常时只打一行原因 + 退出码 1，不打栈。
 * 栈是给写这个脚本的人看的，看流水线的人只需要知道「哪一步、为什么」。
 */
function main() {
  try {
    return run(process.argv.slice(2));
  } catch (error) {
    console.error(`依赖漏洞门禁无法判定：${error.message}`);
    return 1;
  }
}

function run(argv) {
  if (argv.includes('--self-test')) return selfTest();

  if (!existsSync(`${root}${ALLOWLIST_PATH}`)) {
    console.error(
      `缺少 ${ALLOWLIST_PATH}：没有白名单文件时无法区分「没有漏洞」与「没查」。`,
    );
    return 1;
  }

  const allowlist = readJson(`${root}${ALLOWLIST_PATH}`);
  const inputAt = argv.indexOf('--input');
  const graphAt = argv.indexOf('--graph');

  const advisories = normalizeAdvisories(
    inputAt >= 0 ? readJson(argv[inputAt + 1]) : runAudit(),
  );
  const prod = loadProdGraph(
    graphAt >= 0 ? readJson(argv[graphAt + 1]) : runProdGraph(),
  );

  const today = new Date().toISOString().slice(0, 10);
  const { counted, errors, warnings } = evaluate({
    advisories,
    allowlist,
    prod,
    today,
  });

  for (const warning of warnings) console.log(`warn ${warning}`);

  const lines = [
    `上线产物内：${summarize(counted.blocking)}`,
    `开发期工具链：${summarize(counted.dev)}`,
  ];

  if (errors.length > 0) {
    console.error('依赖漏洞门禁未通过：');
    for (const error of errors) console.error(`- ${error}`);
    console.error(`\n${lines.join('\n')}`);
    return 1;
  }

  console.log(
    `依赖漏洞门禁通过 — ${lines.join('；')}，白名单 ${allowlist.entries?.length ?? 0} 条`,
  );
  return 0;
}

process.exit(main());
