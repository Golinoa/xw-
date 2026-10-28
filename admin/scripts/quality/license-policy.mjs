export function evaluateLicenseReport(report, policy) {
  const errors = [];
  const seenExceptions = new Set();

  for (const [packageId, metadata] of Object.entries(report)) {
    const license = metadata.licenses ?? 'UNKNOWN';
    if (policy.allowedLicenses.includes(license)) continue;

    const exception = policy.exceptions[packageId];
    if (!exception) {
      errors.push(`${packageId}: unapproved license ${license}`);
      continue;
    }

    seenExceptions.add(packageId);
    if (exception.licenses !== license) {
      errors.push(
        `${packageId}: expected reviewed license ${exception.licenses}, found ${license}`,
      );
    }
    if (!exception.reason || !exception.reviewedOn) {
      errors.push(`${packageId}: exception must include reason and reviewedOn`);
    }
  }

  for (const packageId of Object.keys(policy.exceptions)) {
    if (!seenExceptions.has(packageId))
      errors.push(`${packageId}: stale exception; review dependency changes`);
  }

  return { errors, ok: errors.length === 0 };
}
