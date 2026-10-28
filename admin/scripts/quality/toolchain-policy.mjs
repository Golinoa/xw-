export function toolchainMismatches(
  actualNode,
  actualPnpm,
  expectedNode,
  expectedPnpm,
) {
  const errors = [];
  if (actualNode !== expectedNode) {
    errors.push(`Node.js ${expectedNode} is required; found ${actualNode}.`);
  }
  if (actualPnpm !== expectedPnpm) {
    errors.push(`pnpm ${expectedPnpm} is required; found ${actualPnpm}.`);
  }
  return errors;
}
