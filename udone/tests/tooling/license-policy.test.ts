import { describe, expect, it } from 'vitest';
import { checkLicenseInventory } from '../../scripts/check-license-policy.mjs';

const policy = {
  allowedExpressions: ['MIT'],
  approvedExceptions: [
    {
      name: 'tool-a',
      version: '1.2.3',
      license: 'WTFPL',
      scope: 'Development-only test tooling.',
      approver: 'Project owner (delegated by user)',
      decisionDate: '2026-10-05',
      obligations: 'Retain upstream license notice if redistributed.',
    },
  ],
};

const item = (name: string, version: string, license = 'WTFPL') => ({
  name,
  versions: [version],
  license,
});

describe('scoped license exceptions', () => {
  it('allows only an exact approved package/version/license outside production', () => {
    const result = checkLicenseInventory({ WTFPL: [item('tool-a', '1.2.3')] }, new Set(), policy);

    expect(result.errors).toEqual([]);
  });

  it('rejects a version or license change and unapproved packages with the same license', () => {
    const result = checkLicenseInventory(
      { WTFPL: [item('tool-a', '1.2.4'), item('tool-b', '1.0.0')] },
      new Set(),
      policy,
    );

    expect(result.errors).not.toEqual([]);

    const licenseChange = checkLicenseInventory(
      { 'Apache-2.0': [item('tool-a', '1.2.3', 'Apache-2.0')] },
      new Set(),
      policy,
    );
    expect(licenseChange.errors).not.toEqual([]);
  });

  it('rejects an approved exception that enters the production dependency tree', () => {
    const result = checkLicenseInventory(
      { WTFPL: [item('tool-a', '1.2.3')] },
      new Set(['tool-a']),
      policy,
    );

    expect(result.errors.join('\n')).toContain('production');
  });

  it('rejects a policy record whose documented dependency scope drifts', () => {
    const result = checkLicenseInventory({ WTFPL: [item('tool-a', '1.2.3')] }, new Set(), {
      ...policy,
      approvedExceptions: [
        {
          ...policy.approvedExceptions[0],
          scope: 'Runtime application dependency.',
        },
      ],
    });

    expect(result.errors.join('\n')).toMatch(/Scope drift/);
  });
});
