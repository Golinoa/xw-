import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { evaluateLicenseReport } from './license-policy.mjs';
import { toolchainMismatches } from './toolchain-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tempPaths = [
  fileURLToPath(
    new URL('../../apps/web-antd/src/quality-lint-canary.js', import.meta.url),
  ),
  fileURLToPath(
    new URL(
      '../../apps/web-antd/src/quality-typecheck-canary.ts',
      import.meta.url,
    ),
  ),
  fileURLToPath(new URL('../../.quality-secret-canary.txt', import.meta.url)),
];
const policy = JSON.parse(
  await readFile(
    new URL('../../.harness/license-policy.json', import.meta.url),
    'utf8',
  ),
);

function runNode(script, args = [], cwd = root) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function mustFail(name, result, expectedOutput) {
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.equal(
    result.error,
    undefined,
    `${name} command could not start: ${result.error?.message}`,
  );
  assert.notEqual(
    result.status,
    0,
    `${name} accepted its intentional failure canary`,
  );
  assert.match(
    output,
    expectedOutput,
    `${name} failed for an unexpected reason`,
  );
  console.log(`${name} rejected its intentional failure canary.`);
}

try {
  await mkdir(new URL('../../apps/web-antd/src/', import.meta.url), {
    recursive: true,
  });
  await writeFile(tempPaths[0], 'export const = ;\n', 'utf8');
  await writeFile(
    tempPaths[1],
    'const qualityTypecheckCanary: string = 42;\n',
    'utf8',
  );
  await writeFile(
    tempPaths[2],
    `GITHUB_TOKEN=${['ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('')}\n`,
    'utf8',
  );

  const eslint = runNode('node_modules/eslint/bin/eslint.js', [
    tempPaths[0],
    '--no-cache',
  ]);
  mustFail('ESLint', eslint, /Parsing error|Unexpected token/);

  const typecheck = runNode(
    fileURLToPath(
      new URL('../../node_modules/vue-tsc/bin/vue-tsc.js', import.meta.url),
    ),
    ['--noEmit', '--skipLibCheck'],
    `${root}/apps/web-antd`,
  );
  mustFail('web-antd typecheck', typecheck, /TS2322/);

  const secretlint = runNode('node_modules/secretlint/bin/secretlint.js', [
    '--secretlintrc',
    '.secretlintrc.json',
    '--secretlintignore',
    '.secretlintignore',
    '--no-terminalLink',
    '--no-glob',
    tempPaths[2],
  ]);
  mustFail('Secretlint', secretlint, /github|ghp/i);

  const licenseResult = evaluateLicenseReport(
    { 'dependency-policy-canary@1.0.0': { licenses: 'UNLICENSED' } },
    policy,
  );
  assert.equal(
    licenseResult.ok,
    false,
    'an unapproved dependency license must fail',
  );
  assert.match(
    licenseResult.errors.join('\n'),
    /dependency-policy-canary@1\.0\.0/,
  );
  console.log(
    'Dependency license policy rejected its intentional UNLICENSED canary.',
  );

  const incompatibleNode = toolchainMismatches(
    '23.0.0',
    '10.33.4',
    '24.20.0',
    '10.33.4',
  );
  assert.match(incompatibleNode.join('\n'), /Node\.js 24\.20\.0 is required/);
  const incompatiblePnpm = toolchainMismatches(
    '24.20.0',
    '10.32.0',
    '24.20.0',
    '10.33.4',
  );
  assert.match(incompatiblePnpm.join('\n'), /pnpm 10\.33\.4 is required/);
  console.log(
    'Toolchain policy rejected incompatible Node.js and pnpm versions.',
  );

  const workflow = await readFile(
    new URL('../../.github/workflows/frontend-quality.yml', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    workflow,
    /\$\{\{\s*secrets\./i,
    'PR workflow must not reference repository secrets',
  );
  const allowedEnv = new Set(['CI', 'FORCE_COLOR', 'TZ']);
  const lines = workflow.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const envBlock = lines[index].match(/^(\s*)env:\s*$/);
    if (!envBlock) continue;
    const indent = envBlock[1].length;
    for (let child = index + 1; child < lines.length; child += 1) {
      const line = lines[child];
      if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
      const variable = line.match(/^\s+([A-Z_][A-Z0-9_]*)\s*:/)?.[1];
      if (variable)
        assert.ok(
          allowedEnv.has(variable),
          `PR workflow environment variable ${variable} is not allowlisted`,
        );
    }
  }
  console.log(
    'PR workflow uses no secret context and every declared environment variable is allowlisted.',
  );
} finally {
  await Promise.all(tempPaths.map((path) => rm(path, { force: true })));
}
