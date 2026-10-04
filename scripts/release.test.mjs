import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(version = '0.1.0') {
  const root = mkdtempSync(join(tmpdir(), 'hanpan-version-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'packages/product-release'), { recursive: true });
  mkdirSync(join(root, 'apps/web/src/bootstrap'), { recursive: true });
  copyFileSync(new URL('./release.mjs', import.meta.url), join(root, 'scripts/release.mjs'));
  const source = join(root, 'packages/product-release/release.json');
  const original = `${JSON.stringify({ version }, null, 2)}\n`;
  writeFileSync(source, original);
  const webConfig = join(root, 'apps/web/src/bootstrap/web-config.ts');
  const webSource = `export const APP_VERSION = '${version}';\n`;
  writeFileSync(webConfig, webSource);
  return {
    source,
    original,
    webConfig,
    webSource,
    run: (...args) =>
      Bun.spawnSync([process.execPath, 'scripts/release.mjs', 'version', ...args], { cwd: root }),
  };
}

test('updates only the product version source and reports the change without Git', () => {
  const setup = fixture();
  const result = setup.run('0.1.1');
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(readFileSync(setup.source, 'utf8'))).toEqual({ version: '0.1.1' });
  expect(readFileSync(setup.webConfig, 'utf8')).toBe(setup.webSource);
  expect(result.stdout.toString()).toContain('0.1.0 → 0.1.1');
});

test.each(['0.0.9', '01.2.3', '1.2', '1.2.3-beta', '1.2.3\n', '', '1'.repeat(130) + '.0.0'])(
  'rejects a lower or malformed version without changing files: %j',
  (version) => {
    const setup = fixture();
    expect(setup.run(version).exitCode).not.toBe(0);
    expect(readFileSync(setup.source, 'utf8')).toBe(setup.original);
    expect(readFileSync(setup.webConfig, 'utf8')).toBe(setup.webSource);
  },
);

test('the current version is a no-op', () => {
  const setup = fixture();
  expect(setup.run('0.1.0').exitCode).toBe(0);
  expect(readFileSync(setup.source, 'utf8')).toBe(setup.original);
});

test('compares numeric components instead of version strings', () => {
  const setup = fixture('1.9.9');
  expect(setup.run('1.10.0').exitCode).toBe(0);
  expect(JSON.parse(readFileSync(setup.source, 'utf8'))).toEqual({ version: '1.10.0' });
});

test('rejects an invalid source or extra arguments without repairing it silently', () => {
  const setup = fixture('invalid');
  expect(setup.run('1.0.0').exitCode).not.toBe(0);
  expect(readFileSync(setup.source, 'utf8')).toBe(setup.original);
  const valid = fixture();
  expect(valid.run('1.0.0', 'extra').exitCode).not.toBe(0);
  expect(readFileSync(valid.source, 'utf8')).toBe(valid.original);
});

test('the checked-in release source is valid even when edited directly', () => {
  const release = JSON.parse(
    readFileSync(new URL('../packages/product-release/release.json', import.meta.url), 'utf8'),
  );
  expect(Object.keys(release)).toEqual(['version']);
  const setup = fixture(release.version);
  expect(setup.run(release.version).exitCode).toBe(0);
});
