import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(
  new URL('../../apps/web-antd/dist/', import.meta.url),
);
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.map',
  '.svg',
  '.txt',
]);
const forbidden = [
  /\bSUPABASE_SERVICE_ROLE_KEY\b/i,
  /\bSERVICE_ROLE_KEY\b/i,
  /\bQINIU_SECRET_KEY\b/i,
  /\bAWS_SECRET_ACCESS_KEY\b/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
];
const matches = [];

async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await scan(path);
    } else if (textExtensions.has(extname(entry.name).toLowerCase())) {
      const content = await readFile(path, 'utf8');
      if (forbidden.some((pattern) => pattern.test(content)))
        matches.push(path);
    }
  }
}

try {
  await scan(dist);
} catch (error) {
  console.error(
    `Cannot inspect web-antd build output at ${dist}: ${error.message}`,
  );
  process.exitCode = 1;
}

if (matches.length > 0) {
  console.error(
    `Server credential markers found in build output:\n${matches.join('\n')}`,
  );
  process.exitCode = 1;
} else if (process.exitCode !== 1) {
  console.log(
    'Built web-antd files and source maps contain no server credential markers.',
  );
}
