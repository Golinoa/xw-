import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'sql-formatter';

const mode = process.argv[2];
if (mode !== '--write' && mode !== '--check') {
  console.error('Usage: node scripts/format-sql.mjs --write|--check');
  process.exit(2);
}

const sqlFiles = [
  ...['supabase/migrations', 'supabase/tests'].flatMap((directory) =>
    readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => join(directory, name)),
  ),
  'supabase/seed.sql',
].filter((file) => {
  try {
    readFileSync(file);
    return true;
  } catch {
    return false;
  }
});

const differences = [];
for (const file of sqlFiles.sort()) {
  const source = readFileSync(file, 'utf8');
  const formatted = format(source, {
    language: 'postgresql',
    keywordCase: 'upper',
    indentStyle: 'standard',
    tabWidth: 2,
    linesBetweenQueries: 2,
  });
  if (source !== formatted) {
    differences.push(file);
    if (mode === '--write') writeFileSync(file, formatted, 'utf8');
  }
}

if (mode === '--check' && differences.length) {
  console.error(
    `SQL formatting required in ${differences.length} file(s):\n${differences.join('\n')}`,
  );
  process.exit(1);
}
if (mode === '--write')
  console.log(`Formatted ${differences.length} of ${sqlFiles.length} SQL file(s).`);
else console.log(`SQL format check passed for ${sqlFiles.length} file(s).`);
