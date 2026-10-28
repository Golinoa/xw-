import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = process.cwd();

async function readPackageName(path: string): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(root, path), 'utf8')) as {
    name?: string;
  };
  return manifest.name ?? '';
}

describe('workspace scaffold', () => {
  beforeEach(() =>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))),
  );
  afterEach(() => vi.unstubAllGlobals());

  it('declares the expected pnpm workspace packages', async () => {
    await expect(readPackageName('package.json')).resolves.toBe('erp');
    await expect(readPackageName('apps/web/package.json')).resolves.toBe('@erp/web');
    await expect(readPackageName('apps/api/package.json')).resolves.toBe('@erp/api');
    await expect(readPackageName('packages/contracts/package.json')).resolves.toBe(
      '@erp/contracts',
    );
  });

  it('exports a Hono app with a health route', async () => {
    const { app } = await import('../../apps/api/src/index');
    const response = await app.request('/api/health', undefined, {
      APP_VERSION: 'test-version',
      SUPABASE_URL: 'https://fixture.supabase.co',
      SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable-key',
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      version: 'test-version',
      dependencies: { supabase: 'available' },
    });
  });
});
