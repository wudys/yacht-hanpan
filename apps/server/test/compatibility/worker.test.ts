import { expect, test } from 'bun:test';

import { runGoldenDrop } from './rapier-golden';
import { runWorkerGoldenDrop } from './worker-harness';

test('Bun worker matches main-thread Rapier and transfers buffers in both directions', async () => {
  const input = new Float32Array([0.5, 1.5, -0.25]);
  const expected = await runGoldenDrop('worker-golden', input.slice());
  const result = await runWorkerGoldenDrop('worker-golden', input);
  expect(input.buffer.byteLength).toBe(0);
  expect(result.signature).toBe(expected.signature);
  expect([...result.samples]).toEqual([...expected.samples]);
  expect(result.samples.buffer.byteLength).toBeGreaterThan(0);
});
