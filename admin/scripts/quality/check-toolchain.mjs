import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { toolchainMismatches } from './toolchain-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const nodeExpected = (await readFile(`${root}/.node-version`, 'utf8')).trim();
const packageJson = JSON.parse(await readFile(`${root}/package.json`, 'utf8'));
const pnpmExpected = packageJson.packageManager?.match(/^pnpm@(.+)$/)?.[1];
const userAgent = process.env.npm_config_user_agent;
const pnpmFromUserAgent = userAgent?.match(
  /(?:^|\s)pnpm\/(\d+\.\d+\.\d+)/,
)?.[1];
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const pnpmActual = userAgent
  ? (pnpmFromUserAgent ?? `non-pnpm client (${userAgent.split(' ')[0]})`)
  : execFileSync(pnpmCommand, ['--version'], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }).trim();

const errors = pnpmExpected
  ? toolchainMismatches(
      process.versions.node,
      pnpmActual,
      nodeExpected,
      pnpmExpected,
    )
  : ['package.json must pin packageManager to an exact pnpm version.'];

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(
    `Toolchain matches Node.js ${nodeExpected} and pnpm ${pnpmExpected}.`,
  );
}
