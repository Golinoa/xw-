import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateLicenseReport } from './license-policy.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const checker = join(
  root,
  'node_modules/license-checker-rseidelsohn/bin/license-checker-rseidelsohn.js',
);
const tempDir = await mkdtemp(join(tmpdir(), 'ops-console-license-'));
const reportPath = join(tempDir, 'licenses.json');

try {
  execFileSync(
    process.execPath,
    [checker, '--json', '--excludePrivatePackages', '--out', reportPath],
    { cwd: root, stdio: 'inherit' },
  );
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  const policy = JSON.parse(
    await readFile(join(root, '.harness/license-policy.json'), 'utf8'),
  );
  const result = evaluateLicenseReport(report, policy);

  if (!result.ok) {
    console.error('License policy failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `License policy passed for ${Object.keys(report).length} installed packages; ${Object.keys(policy.exceptions).length} exact-version exceptions.`,
    );
  }
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
