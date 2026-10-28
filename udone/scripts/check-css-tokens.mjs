import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function findRawColorValues(source) {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  );
  const pattern = /#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-f])|\b(?:rgba?|hsla?)\s*\(/gi;
  return [...withoutComments.matchAll(pattern)].map((match) => ({
    line: withoutComments.slice(0, match.index).split('\n').length,
    value: match[0],
  }));
}

function sourceStyles(file, source) {
  if (extname(file) !== '.vue') return [source];
  return [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((match) => match[1]);
}

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return ['.vue', '.css'].includes(extname(entry.name)) ? [path] : [];
  });
}

const legacyRawColorAllowance = {
  'apps/web/src/layouts/AppLayout.vue': {
    '#f5f7fa': 1,
    '#263445': 1,
    '#e5eaf0': 1,
  },
  'apps/web/src/views/HomeView.vue': { '#e5eaf0': 1 },
  'apps/web/src/views/LoginView.vue': {
    '#f5f7fa': 1,
    '#e5eaf0': 1,
  },
};

if (process.argv[2] === '--self-test') {
  assert.equal(findRawColorValues('/* #000 ignored */\n.card { color: #abc; }').length, 1);
  assert.equal(findRawColorValues('.card { color: var(--color-text); }').length, 0);
  console.log('CSS token check rejects a synthetic raw color and allows a design token.');
} else {
  const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
  const sourceRoot = resolve(repositoryRoot, 'apps/web/src');
  const violations = [];
  for (const file of sourceFiles(sourceRoot)) {
    const relativePath = relative(repositoryRoot, file).replace(/\\/g, '/');
    const remainingAllowance = { ...(legacyRawColorAllowance[relativePath] ?? {}) };
    const source = readFileSync(file, 'utf8');
    for (const style of sourceStyles(file, source)) {
      for (const match of findRawColorValues(style)) {
        const color = match.value.toLowerCase();
        if (remainingAllowance[color]) {
          remainingAllowance[color] -= 1;
        } else {
          violations.push(`${relativePath}:${match.line} (${match.value})`);
        }
      }
    }
  }
  if (violations.length) {
    console.error(
      `Use design-token variables instead of raw CSS color values:\n${violations.join('\n')}`,
    );
    process.exitCode = 1;
  } else {
    console.log(`CSS token check passed for ${relative(repositoryRoot, sourceRoot)}.`);
  }
}
