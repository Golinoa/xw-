import { existsSync, readFileSync } from 'node:fs';
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

    // 逐项断言而不是整行比对：include 迟早会多一个目录（这次加了 scripts/），
    // 整行匹配失败会把「有人把 include 放开成 **/*.test.ts」和「精确地多了
    // 一个目录」报成同一个错。前者是真问题，后者不是。
    for (const root of [
      'apps/**/*.test.ts',
      'packages/**/*.test.ts',
      'tests/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ]) {
      expect(config).toContain(`'${root}'`);
    }

    // 真正要守的是这条：任何通配到全仓的 include 都会让「单元测试不需要数据库」
    // 失效——tests/integration 一旦被扫进来，没起库的机器上会整片红。
    const includeBlock = config.slice(
      config.indexOf('include:'),
      config.indexOf(']', config.indexOf('include:')),
    );
    expect(includeBlock).not.toContain("'**/*.test");

    expect(config).toContain("'**/.worktrees/**'");
  });

  it('pins CI to local commands and does not run against a remote database', () => {
    /**
     * GitHub Actions 只读【仓库根】的 `.github/workflows/`。
     *
     * 这条断言原先读的是 `udone/.github/workflows/ci.yml` —— 那份永远不会被执行
     * （GitHub 不扫子目录），于是「CI 已覆盖 deps:audit / licenses / secrets」
     * 只是纸面结论，实际一条都没跑过。断言必须指向真会跑的那份，否则守的是装饰品。
     */
    const workflow = readFileSync(
      new URL('../../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    );

    for (const command of [
      'pnpm install --frozen-lockfile',
      'pnpm format:check',
      'pnpm lint',
      'pnpm typecheck',
      'pnpm test',
      'pnpm build',
      'pnpm check:deploy',
      'pnpm deps:audit',
      'pnpm licenses:check',
      'pnpm secrets:check',
      'pnpm secrets:canary:check',
      'pnpm schema:check',
      'pnpm e2e',
    ]) {
      expect(workflow).toContain(command);
    }

    // 浏览器安装行装的是系统库；删掉它能让用例「假装通过」，所以单独守住。
    expect(workflow).toContain('playwright install --with-deps chromium');

    // 反过来守一次：子目录里不许再有第二份，否则「改了这份、跑的是那份」会重演。
    expect(existsSync(new URL('../../.github/workflows/ci.yml', import.meta.url))).toBe(false);

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

  /**
   * 场景：`a-deps-biz`。此前 `deps:audit` 只是个脚本、不在门禁里，于是业务端
   * 11 道门禁全绿而实际带 7 条 high——「没发现问题」与「没去查」显示成一样。
   *
   * 这三条一起才有意义：脚本存在、它真的会红、白名单必须带到期日。
   */
  it('routes deps:audit through the allowlist policy instead of a raw audit dump', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;

    expect(scripts['deps:audit']).toContain('check-deps-audit.mjs');
    // 原始输出仍然可用（排障要看得懂全量），但它不再是门禁本身。
    expect(scripts['deps:audit:raw']).toContain('pnpm audit');
  });

  it('fails the dependency gate on an unlisted high severity advisory', () => {
    const result = spawnSync(process.execPath, ['scripts/check-deps-audit.mjs', '--self-test'], {
      cwd: new URL('../../', import.meta.url),
      encoding: 'utf8',
    });

    // 自测里包含「critical 不在白名单 → 红」「已到期 → 红」「条目失效 → 红」
    // 与「moderate 不阻断」四条；它们一起说明这个门禁既会红也会放行。
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('critical 不在白名单 → 红');
    expect(result.stdout).toContain('high 在白名单但已到期 → 红');
  });

  it('requires an expiry date on every dependency allowlist entry', () => {
    const allowlist = JSON.parse(read('scripts/deps-allowlist.json')) as {
      policyNote?: string;
      entries?: { module?: string; reason?: string; expires?: string }[];
    };

    expect(allowlist.policyNote).toBeTruthy();
    for (const entry of allowlist.entries ?? []) {
      expect(entry.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.reason).toBeTruthy();
    }
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
