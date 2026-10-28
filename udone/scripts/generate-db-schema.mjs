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
