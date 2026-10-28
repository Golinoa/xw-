import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const secretlint = fileURLToPath(
  new URL('../node_modules/secretlint/bin/secretlint.js', import.meta.url),
);
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'udone-secret-canary-'));
const canaryFile = join(temporaryDirectory, 'canary.txt');
const canary = `ghp_${'0123456789abcdef'.repeat(2)}abcd`;

try {
  writeFileSync(canaryFile, `synthetic secret scan canary: ${canary}\n`, 'utf8');
  const result = spawnSync(
    process.execPath,
    [secretlint, '--maskSecrets', '--no-color', canaryFile],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) {
    console.error('Secret scanner did not reject the synthetic credential canary.');
    process.exitCode = 1;
  } else if (`${result.stdout}${result.stderr}`.includes(canary)) {
    console.error('Secret scanner output included the synthetic canary; redaction is required.');
    process.exitCode = 1;
  } else {
    console.log('Secret scanner rejected and redacted the synthetic canary.');
  }
} finally {
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
