import { describe, expect, test } from 'bun:test';

import { runGoldenDrop } from './rapier-golden';

describe('deterministic Rapier compatibility', () => {
  test('returns byte-stable output for the same seed and input', async () => {
    const input = new Float32Array([0.25, -0.5, 1.25]);

    const first = await runGoldenDrop('golden-seed', input);
    const second = await runGoldenDrop('golden-seed', input);

    expect(second.signature).toBe(first.signature);
    expect([...second.samples]).toEqual([...first.samples]);
  });

  test('changes the physical result for a selected different seed', async () => {
    const input = new Float32Array([0.25, -0.5, 1.25]);

    const first = await runGoldenDrop('golden-seed-a', input);
    const second = await runGoldenDrop('golden-seed-b', input);

    expect(second.signature).not.toBe(first.signature);
  });
});
