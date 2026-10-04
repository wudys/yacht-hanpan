import { describe, expect, test } from 'bun:test';

const packageRoot = new URL('../..', import.meta.url);

describe('dice simulation package boundary', () => {
  test('does not depend on game, wire, rendering, or audio playback packages', async () => {
    const packageJson = await Bun.file(new URL('package.json', packageRoot)).json();
    expect(Object.keys(packageJson.dependencies)).toEqual([
      '@dimforge/rapier3d-deterministic',
      '@noble/hashes',
    ]);

    const forbiddenImports: string[] = [];
    const glob = new Bun.Glob('src/**/*.ts');
    for await (const path of glob.scan({ cwd: packageRoot.pathname })) {
      const source = await Bun.file(new URL(path, packageRoot)).text();
      const imports = source.matchAll(/from\s+['\"]([^'\"]+)['\"]/g);
      for (const match of imports) {
        if (/^@repo\/(game-protocol|room|yacht)|react|three|tone/.test(match[1] ?? '')) {
          forbiddenImports.push(`${path}:${match[1]}`);
        }
      }
    }
    expect(forbiddenImports).toEqual([]);
  });

  test('does not generate secure identifiers, seeds, or nondeterministic randomness', async () => {
    const violations: string[] = [];
    const glob = new Bun.Glob('src/**/*.ts');
    for await (const path of glob.scan({ cwd: packageRoot.pathname })) {
      if (path.endsWith('.test.ts')) continue;
      const source = await Bun.file(new URL(path, packageRoot)).text();
      if (/randomUUID|crypto\.random|Math\.random/.test(source)) violations.push(path);
    }
    expect(violations).toEqual([]);
  });
});
