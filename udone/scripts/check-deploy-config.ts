import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();

async function readText(path: string): Promise<string> {
  try {
    return await readFile(resolve(root, path), 'utf8');
  } catch {
    return '';
  }
}

async function filesUnder(path: string): Promise<string[]> {
  try {
    const entries = await readdir(resolve(root, path), { withFileTypes: true });
    const nested = await Promise.all(
      entries.map((entry) => {
        const child = join(path, entry.name);
        return entry.isDirectory() ? filesUnder(child) : Promise.resolve([child]);
      }),
    );
    return nested.flat();
  } catch {
    return [];
  }
}

function dotenvValues(contents: string): Array<{ name: string; value: string }> {
  return contents.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) return [];
    return [{ name: match[1], value: match[2].replace(/^(["'])(.*)\1$/, '$2') }];
  });
}

export function hasSecretLeak(
  artifacts: readonly string[],
  secretValues: readonly string[],
): boolean {
  return artifacts.some(
    (artifact) =>
      /service_role_[A-Za-z0-9_-]{20,}/i.test(artifact) ||
      secretValues.some((value) => Boolean(value) && artifact.includes(value)),
  );
}

export async function checkDeployConfig(): Promise<string[]> {
  const issues: string[] = [];
  const config = await readText('wrangler.toml');
  const workerEnv = await readText('apps/api/src/env.d.ts');
  const example = await readText('.env.example');
  const configRequirements = [
    'name = "udone-oms"',
    'main = "apps/api/src/index.ts"',
    'directory = "apps/web/dist"',
    'not_found_handling = "single-page-application"',
    'run_worker_first = ["/api/*"]',
    '[version_metadata]',
    'binding = "CF_VERSION_METADATA"',
  ];
  for (const requirement of configRequirements) {
    if (!config.includes(requirement))
      issues.push(`Wrangler configuration is missing ${requirement}`);
  }
  if (/ATTACHMENTS|r2_buckets|R2_OPTIONAL/i.test(config)) {
    issues.push('Wrangler configuration must not require deferred object storage');
  }

  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (!workerEnv.includes(name)) issues.push(`Worker environment types are missing ${name}`);
  }
  for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    const assignment = example.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (!assignment) issues.push(`.env.example is missing ${name}`);
    if (name === 'SUPABASE_SERVICE_ROLE_KEY' && assignment?.[1].trim()) {
      issues.push('.env.example must not contain a service-role key value');
    }
  }

  const artifactPaths = await filesUnder('apps/web/dist');
  if (artifactPaths.length === 0)
    issues.push('Frontend build output is missing; run pnpm build first');
  const artifacts = await Promise.all(artifactPaths.map((path) => readText(path)));
  const secretValues: string[] = [];
  for (const name of ['SUPABASE_SERVICE_ROLE_KEY', 'VITE_SUPABASE_SERVICE_ROLE_KEY']) {
    const value = process.env[name];
    if (value) secretValues.push(value);
  }
  for (const directory of [root, resolve(root, 'apps/web')]) {
    const directoryFiles = await readdir(directory).catch(() => [] as string[]);
    const localEnvFiles = directoryFiles
      .filter((name) => /^\.dev\.vars(?:\..*)?$|^\.env(?:\..*)?$/.test(name))
      .map((name) => resolve(directory, name));
    for (const path of localEnvFiles) {
      const values = dotenvValues(await readFile(path, 'utf8'));
      for (const item of values) {
        if (/SERVICE_ROLE|SECRET|PASSWORD|TOKEN/i.test(item.name) && item.value)
          secretValues.push(item.value);
      }
    }
  }
  if (hasSecretLeak(artifacts, secretValues))
    issues.push('A server-side secret value appears in frontend build output');

  return issues;
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/check-deploy-config.ts')) {
  void checkDeployConfig()
    .then((issues) => {
      if (issues.length) {
        console.error(
          `Deployment configuration check failed (${issues.length} issue${issues.length === 1 ? '' : 's'}):`,
        );
        for (const issue of issues) console.error(`- ${issue}`);
        process.exitCode = 1;
      } else {
        console.log('Deployment configuration checks passed.');
      }
    })
    .catch(() => {
      console.error('Deployment configuration check could not complete.');
      process.exitCode = 1;
    });
}
