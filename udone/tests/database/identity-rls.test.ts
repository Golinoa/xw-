import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const migration = (name: string) =>
  readFileSync(resolve(root, 'supabase/migrations', name), 'utf8');

describe('identity tenant isolation schema', () => {
  it('uses timestamped migrations in CLI application order', () => {
    const migrations = readdirSync(resolve(root, 'supabase/migrations')).filter((name) =>
      name.endsWith('.sql'),
    );
    const versions = migrations.map((name) => name.match(/^(\d{14})_.+\.sql$/)?.[1]);

    expect(versions.every((version): version is string => version !== undefined)).toBe(true);
    expect(versions).toEqual([...versions].sort());
  });

  it('defines the required identity tables and organization membership uniqueness', () => {
    const schema = migration('20261003000000_identity.sql');
    for (const table of ['organizations', 'organization_members', 'profiles', 'audit_events']) {
      expect(schema).toMatch(new RegExp(`create table public\\.${table}\\b`, 'i'));
    }
    expect(schema).toMatch(/unique\s*\(\s*organization_id\s*,\s*user_id\s*\)/i);
    expect(schema.match(/enable row level security/gi)).toHaveLength(4);
  });

  it('binds access to authenticated identity and selected organization', () => {
    const helpers = migration('20261003000001_rls_helpers.sql');
    expect(helpers).toMatch(/current_organization_id\s*\(\s*\)\s*returns uuid/i);
    expect(helpers).toMatch(/has_permission\s*\(\s*permission\s+text\s*\)\s*returns boolean/i);
    expect(helpers).toMatch(/auth\.uid\(\)/i);
    expect(helpers).toMatch(/organization_id/i);
    expect(helpers).toMatch(/organization_members_update_current_admin[\s\S]*?with\s+check/i);
  });

  it('includes executable pgTAP coverage for membership reads and tenant reassignment', () => {
    const policyTest = readFileSync(resolve(root, 'supabase/tests/identity_rls.sql'), 'utf8');
    expect(policyTest).toMatch(/plan\s*\(/i);
    expect(policyTest).toMatch(/non.member|non_member/i);
    expect(policyTest).toMatch(/organization_id/i);
    expect(policyTest).toMatch(/finish\s*\(\s*\)/i);
    expect(policyTest.match(/\b(?:is|ok|throws_ok)\s*\(/gi)).toHaveLength(15);
  });

  it('provides Supabase CLI config and an explicit seed file', () => {
    expect(existsSync(resolve(root, 'supabase/config.toml'))).toBe(true);
    expect(existsSync(resolve(root, 'supabase/seed.sql'))).toBe(true);
  });
});
