import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  console.error('Usage: node scripts/generate-db-schema.mjs --write|--check');
  process.exit(2);
}

const migrationDirectory = 'supabase/migrations';
const migrations = readdirSync(migrationDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, source: readFileSync(join(migrationDirectory, name), 'utf8') }));

if (migrations.length === 0) {
  console.error(`No SQL migrations found in ${migrationDirectory}.`);
  process.exit(1);
}

// 迁移版本号：`<14 位时间戳>_<name>.sql` 的前缀。
//
// 为什么在这里查而不是交给 supabase CLI：CLI 遇到重复版本号时行为是「跑其中一个」，
// 不报错。两个同号迁移在本地按文件名排序看起来都对，到线上只跑了一个——症状是
// 「这个字段本地有、线上没有」，而没有任何一处日志说迁移被跳过了。
//
// 顺带查形态：版本号不是 14 位数字时，字典序排序与时间序不再一致（`2026...` 与
// `20261031...` 混排），迁移顺序会静默改变。
//
// 这两条从 T-14 的验收断言来：「空库全量重放成功且迁移版本号无重复」。
const versions = migrations.map(({ name }) => name.split('_')[0]);
const duplicateVersions = [...new Set(versions.filter((v, i) => versions.indexOf(v) !== i))];
const malformedVersions = versions.filter((version) => !/^\d{14}$/.test(version));

if (duplicateVersions.length > 0) {
  console.error(`重复的迁移版本号：${duplicateVersions.join(', ')}`);
  process.exit(1);
}

if (malformedVersions.length > 0) {
  console.error(`迁移版本号必须是 14 位时间戳：${malformedVersions.join(', ')}`);
  process.exit(1);
}

function matches(source, pattern) {
  return [...source.matchAll(pattern)].map((match) => match[1].replaceAll('"', ''));
}

const objects = migrations.map(({ name, source }) => ({
  name,
  tables: matches(source, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi),
  functions: matches(source, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w."]+)/gi),
  indexes: matches(source, /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w."]+)/gi),
  policies: matches(source, /CREATE\s+POLICY\s+([\w."]+)/gi),
  triggers: matches(source, /CREATE\s+TRIGGER\s+([\w."]+)/gi),
}));

const totals = Object.fromEntries(
  ['tables', 'functions', 'indexes', 'policies', 'triggers'].map((key) => [
    key,
    objects.reduce((sum, migration) => sum + migration[key].length, 0),
  ]),
);

const rows = objects.map(({ name, ...entries }) => {
  const cells = ['tables', 'functions', 'indexes', 'policies', 'triggers'].map((key) =>
    entries[key].length ? entries[key].map((entry) => `\`${entry}\``).join(', ') : '—',
  );
  return `| \`${name}\` | ${cells.join(' | ')} |`;
});

const report = [
  '<!-- AUTO-GENERATED FILE: generated from supabase/migrations by scripts/generate-db-schema.mjs. Do not hand edit. -->',
  '# Database schema inventory',
  '',
  '> Migration-derived object inventory. Names are extracted from SQL declarations; this report does not infer product fields or runtime behavior.',
  '',
  `- Migration sources scanned: ${migrations.length}`,
  `- Tables discovered: ${totals.tables}`,
  `- Functions discovered: ${totals.functions}`,
  `- Indexes discovered: ${totals.indexes}`,
  `- RLS policies discovered: ${totals.policies}`,
  `- Triggers discovered: ${totals.triggers}`,
  '',
  '| Migration | Tables | Functions | Indexes | Policies | Triggers |',
  '|---|---|---|---|---|---|',
  ...rows,
  '',
].join('\n');

const target = '.harness/docs/generated/db-schema.md';
if (mode === '--write') {
  writeFileSync(target, report, 'utf8');
  console.log(`Generated ${target} from ${migrations.length} migration(s).`);
} else {
  let current;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== report) {
    console.error(`${target} is stale; run pnpm schema:generate and commit the generated report.`);
    process.exit(1);
  }
  console.log(`Schema inventory matches ${migrations.length} migration(s).`);
}
