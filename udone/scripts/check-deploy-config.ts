import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = process.cwd();

/** Every literal that must appear in wrangler.toml for a deployable Worker. */
export const WRANGLER_REQUIREMENTS = [
  'name = "udone-oms"',
  'main = "apps/api/src/index.ts"',
  'directory = "apps/web/dist"',
  'not_found_handling = "single-page-application"',
  'run_worker_first = ["/api/*"]',
  '[version_metadata]',
  'binding = "CF_VERSION_METADATA"',
  '[observability]',
] as const;

/** Server-only values the Worker type surface must declare. */
export const WORKER_ENV_VARIABLES = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ALLOW_LOCAL_JWT_AUTH',
] as const;

/** Variables .env.example must document; secrets stay blank, config carries a usable default. */
export const ENV_EXAMPLE_VARIABLES = [
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ALLOWED_ORIGINS',
  'RATE_LIMIT_PER_MINUTE',
  'ALLOW_LOCAL_JWT_AUTH',
] as const;

const BLANK_IN_EXAMPLE = new Set([
  'SUPABASE_URL',
  'SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
]);

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
  const configRequirements = WRANGLER_REQUIREMENTS;
  for (const requirement of configRequirements) {
    if (!config.includes(requirement))
      issues.push(`Wrangler configuration is missing ${requirement}`);
  }
  if (/ATTACHMENTS|r2_buckets|R2_OPTIONAL/i.test(config)) {
    issues.push('Wrangler configuration must not require deferred object storage');
  }

  for (const name of WORKER_ENV_VARIABLES) {
    if (!workerEnv.includes(name)) issues.push(`Worker environment types are missing ${name}`);
  }
  for (const name of ENV_EXAMPLE_VARIABLES) {
    const assignment = example.match(new RegExp(`^${name}=(.*)$`, 'm'));
    if (!assignment) {
      issues.push(`.env.example is missing ${name}`);
      continue;
    }
    const value = assignment[1].trim();
    if (BLANK_IN_EXAMPLE.has(name) && value) {
      issues.push(`.env.example must not contain a ${name} value`);
    }
    if (!BLANK_IN_EXAMPLE.has(name) && !value) {
      issues.push(`.env.example must document a usable ${name} default`);
    }
    if (name === 'ALLOWED_ORIGINS' && value === '*') {
      issues.push('.env.example must not allow wildcard origins');
    }
    if (name === 'ALLOW_LOCAL_JWT_AUTH' && value !== 'false') {
      issues.push('.env.example must leave the local JWT channel off');
    }
  }

  /**
   * 本地自签令牌通道在生产里出现即失败，不看值是什么。
   *
   * 关掉的写法有很多种（`"false"`、注释、删掉），而「配了但没生效」与
   * 「配了且生效」在部署日志里长得一样。所以这条断言不判断语义，只判断
   * **这个名字有没有出现在部署配置里**：出现就要人来看一眼，没出现就不可能被打开。
   */
  if (/ALLOW_LOCAL_JWT_AUTH/i.test(config)) {
    issues.push('Wrangler configuration must not define ALLOW_LOCAL_JWT_AUTH');
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
