import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ENV_EXAMPLE_VARIABLES,
  WRANGLER_REQUIREMENTS,
  hasSecretLeak,
} from '../../scripts/check-deploy-config';

const root = process.cwd();

describe('Worker deployment configuration', () => {
  it('detects configured secret values and service-role JWT markers in frontend bundles', () => {
    expect(hasSecretLeak(['bundle with test-only-secret'], ['test-only-secret'])).toBe(true);
    expect(hasSecretLeak(['bundle with service_role_test-token-12345678901234567890'], [])).toBe(
      true,
    );
    expect(hasSecretLeak(['ordinary frontend code'], ['test-only-secret'])).toBe(false);
  });

  it('builds the SPA and routes API requests through a Worker with the required bindings', async () => {
    const config = await readFile(resolve(root, 'wrangler.toml'), 'utf8');
    const workerEnv = await readFile(resolve(root, 'apps/api/src/env.d.ts'), 'utf8');

    expect(config).toContain('main = "apps/api/src/index.ts"');
    expect(config).toContain('directory = "apps/web/dist"');
    expect(config).toContain('run_worker_first = ["/api/*"]');
    expect(config).toContain('[version_metadata]');
    expect(config).toContain('binding = "CF_VERSION_METADATA"');
    expect(config).not.toMatch(/ATTACHMENTS|r2_buckets|R2_OPTIONAL/i);
    for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
      expect(workerEnv).toContain(name);
    }
    expect(workerEnv).not.toMatch(/ATTACHMENTS|R2_OPTIONAL|R2Bucket/i);
    expect(config).not.toContain('SUPABASE_SERVICE_ROLE_KEY =');
    expect(config).not.toMatch(/service_role_[A-Za-z0-9_-]{20,}/i);
  });

  it('documents runtime variables without committing values', async () => {
    const example = await readFile(resolve(root, '.env.example'), 'utf8');
    for (const name of ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
      expect(example).toMatch(new RegExp(`^${name}=$`, 'm'));
    }
  });

  it('gates the cross-origin allowlist and rate-limit ceiling', async () => {
    const example = await readFile(resolve(root, '.env.example'), 'utf8');

    expect(ENV_EXAMPLE_VARIABLES).toContain('ALLOWED_ORIGINS');
    expect(ENV_EXAMPLE_VARIABLES).toContain('RATE_LIMIT_PER_MINUTE');
    expect(example).toMatch(/^ALLOWED_ORIGINS=.+/m);
    expect(example).not.toMatch(/^ALLOWED_ORIGINS=\*$/m);
    expect(example).toMatch(/^RATE_LIMIT_PER_MINUTE=\d+$/m);
  });

  it('gates Worker observability so logs are not silently dropped', () => {
    expect(WRANGLER_REQUIREMENTS).toContain('[observability]');
  });
});
