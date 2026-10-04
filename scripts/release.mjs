import { readFileSync, writeFileSync } from 'node:fs';

const sourcePath = new URL('../packages/product-release/release.json', import.meta.url);
const { version: current } = JSON.parse(readFileSync(sourcePath, 'utf8'));
const [command, version, ...extra] = process.argv.slice(2);

function parseVersion(value) {
  if (
    typeof value !== 'string' ||
    value.length > 128 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(value)
  ) {
    throw new Error('Use a version such as 0.1.1 (major.minor.patch, at most 128 characters).');
  }
  return value.split('.').map(BigInt);
}

if (command !== 'version' || version === undefined || extra.length !== 0) {
  throw new Error('Usage: bun run version:set <major.minor.patch>');
}
const previous = parseVersion(current);
const next = parseVersion(version);
const changedComponent = next.findIndex((value, index) => value !== previous[index]);
if (changedComponent !== -1 && next[changedComponent] < previous[changedComponent]) {
  throw new Error(
    'A new release must not lower the version. Roll back using the previous artifacts.',
  );
}
if (version !== current) {
  writeFileSync(sourcePath, `${JSON.stringify({ version }, null, 2)}\n`);
}
console.log(
  `Product version: ${current} → ${version}${version === current ? ' (unchanged)' : ''}.`,
);
