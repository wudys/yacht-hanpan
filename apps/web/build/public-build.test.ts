import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

const script = fileURLToPath(new URL('../scripts/check-public-build.mjs', import.meta.url));

test('the public build guard accepts assets and rejects nested source maps', async () => {
  const output = await mkdtemp(join(tmpdir(), 'hanpan-public-build-'));
  try {
    const nested = join(output, 'assets', 'nested');
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, 'file.js'), 'export const ready = true;');
    await writeFile(join(output, 'assets', 'style.css'), 'body { margin: 0; }');
    const accepted = spawnSync(process.execPath, [script, output], { encoding: 'utf8' });
    expect(accepted.error).toBeUndefined();
    expect(accepted.status, accepted.stderr).toBe(0);

    await writeFile(join(nested, 'file.js.map'), '{}');
    const rejected = spawnSync(process.execPath, [script, output], { encoding: 'utf8' });
    expect(rejected.error).toBeUndefined();
    expect(rejected.status).not.toBeNull();
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toMatch(/Public build contains source maps/u);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
