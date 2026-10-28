import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('repository engineering gates', () => {
  it('defines reproducible format, lint, and schema inventory commands', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;

    expect(scripts['format:check']).toBeTruthy();
    expect(scripts['format:sql:check']).toBeTruthy();
    expect(scripts.lint).toBeTruthy();
    expect(scripts['css:tokens:check']).toBeTruthy();
    expect(scripts['deps:audit']).toBeTruthy();
    expect(scripts['licenses:check']).toBeTruthy();
    expect(scripts['secrets:check']).toBeTruthy();
    expect(scripts['schema:check']).toBeTruthy();
    expect(read('.node-version').trim()).toMatch(/^24\.\d+\.\d+$/);
    expect(JSON.parse(read('package.json')).packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
  });

  it('keeps generated and machine-local directories outside formatter scope', () => {
    const ignored = read('.prettierignore');

    for (const path of [
      'node_modules/',
      '**/node_modules/**',
      'coverage/',
      '**/coverage/**',
      'dist/',
      '**/dist/**',
      'test-results/',
      '**/test-results/**',
      '.wrangler/',
      '**/.wrangler/**',
      '.worktrees/',
      '**/.worktrees/**',
      'supabase/.temp/',
    ]) {
      expect(ignored.split(/\r?\n/)).toContain(path);
    }
  });

  it('limits Vitest discovery to project test roots and excludes managed worktrees', () => {
    const config = read('vitest.config.ts');

    expect(config).toContain(
      "include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts']",
    );
    expect(config).toContain("'**/.worktrees/**'");
  });

  it('pins CI to local commands and does not run against a remote database', () => {
    const workflow = read('.github/workflows/ci.yml');

    for (const command of [
      'pnpm install --frozen-lockfile',
      'pnpm format:check',
      'pnpm format:sql:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm check:deploy',
      'pnpm deps:audit',
      'pnpm licenses:check',
      'pnpm secrets:check',
      'pnpm schema:check',
      'pnpm db:test',
    ]) {
      expect(workflow).toContain(command);
    }
    expect(workflow).not.toMatch(/supabase db (push|reset) --linked|wrangler deploy/i);
  });

  it('blocks a synthetic credential canary without printing its value', () => {
    const result = spawnSync(process.execPath, ['scripts/check-secret-canary.mjs'], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('regenerates a migration-backed schema inventory deterministically', () => {
    const result = spawnSync(process.execPath, ['scripts/generate-db-schema.mjs', '--check'], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects a synthetic unapproved license expression', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/check-license-policy.mjs', '--self-test'],
      {
        cwd: new URL('../../', import.meta.url),
        encoding: 'utf8',
      },
    );

    expect(result.status, result.stderr).toBe(0);
  });

  it('rejects synthetic hard-coded CSS colors to enforce design tokens', () => {
    const result = spawnSync(process.execPath, ['scripts/check-css-tokens.mjs', '--self-test'], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
    });

    expect(result.status, result.stderr).toBe(0);
  });
});
