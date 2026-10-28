import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const policy = JSON.parse(readFileSync('scripts/license-policy.json', 'utf8'));

export function checkLicenseInventory(inventory, productionPackages, currentPolicy = policy) {
  const errors = [];
  const allowed = new Set(currentPolicy.allowedExpressions);
  const exceptions = currentPolicy.approvedExceptions ?? [];

  for (const exception of exceptions) {
    if (
      !exception.scope ||
      !exception.approver ||
      !exception.decisionDate ||
      !exception.obligations
    ) {
      errors.push(`Incomplete approval record for ${exception.name}@${exception.version}.`);
    }
    if (exception.scope && !/^development-only\b/i.test(exception.scope)) {
      errors.push(
        `Scope drift for ${exception.name}@${exception.version}: only development tooling is approved.`,
      );
    }
  }

  for (const [expression, packages] of Object.entries(inventory)) {
    if (allowed.has(expression)) continue;

    for (const dependency of packages) {
      const versions = dependency.versions ?? [];
      for (const version of versions) {
        const approved = exceptions.some(
          (entry) =>
            entry.name === dependency.name &&
            entry.version === version &&
            entry.license === expression,
        );

        if (!approved) {
          errors.push(`Unapproved expression ${expression}: ${dependency.name}@${version}.`);
        } else if (productionPackages.has(dependency.name)) {
          errors.push(
            `Approved exception ${dependency.name}@${version} is in the production dependency tree.`,
          );
        }
      }
    }
  }

  return { errors };
}

function productionPackageNames() {
  const output = execSync('pnpm list --prod --recursive --json', {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const roots = JSON.parse(output);
  const names = new Set();

  function visit(nodes) {
    for (const node of nodes ?? []) {
      if (node.name) names.add(node.name);
      for (const [name, dependency] of Object.entries(node.dependencies ?? {})) {
        names.add(name);
        visit([dependency]);
      }
    }
  }

  visit(roots);
  return names;
}

async function main() {
  if (process.argv[2] === '--self-test') {
    const testPolicy = {
      allowedExpressions: ['MIT'],
      approvedExceptions: [
        {
          name: 'tool-a',
          version: '1.2.3',
          license: 'WTFPL',
          scope: 'Development-only test tooling.',
          approver: 'Project owner',
          decisionDate: '2026-10-05',
          obligations: 'Retain upstream license notice if redistributed.',
        },
      ],
    };
    const dep = (name, version, license = 'WTFPL') => ({ name, versions: [version], license });
    assert.deepEqual(
      checkLicenseInventory({ WTFPL: [dep('tool-a', '1.2.3')] }, new Set(), testPolicy).errors,
      [],
    );
    assert.notDeepEqual(
      checkLicenseInventory(
        { WTFPL: [dep('tool-a', '1.2.4'), dep('tool-b', '1.0.0')] },
        new Set(),
        testPolicy,
      ).errors,
      [],
    );
    assert.match(
      checkLicenseInventory(
        { WTFPL: [dep('tool-a', '1.2.3')] },
        new Set(['tool-a']),
        testPolicy,
      ).errors.join('\n'),
      /production/,
    );
    console.log('License policy rejected version, package, and production-scope drift.');
    return;
  }

  let input = '';
  for await (const chunk of process.stdin) input += chunk;

  let inventory;
  try {
    inventory = JSON.parse(input);
  } catch {
    console.error('Could not parse `pnpm licenses list --json` output.');
    process.exitCode = 2;
    return;
  }

  const result = checkLicenseInventory(inventory, productionPackageNames());
  if (result.errors.length) {
    console.error('Unapproved dependency license expression(s):');
    for (const error of result.errors) console.error(`- ${error}`);
    console.error(
      'Review scripts/license-policy.json; exceptions must remain exact and development-only.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `License policy passed for ${Object.values(inventory).flat().length} installed package groups.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
