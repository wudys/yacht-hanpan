import { expect, test } from 'bun:test';

import { runDeterministicRapierDrop } from './deterministic-rapier-drop';
import { runRapierTransferProbe } from './rapier-transfer-harness';

test('Bun worker matches main-thread Rapier and transfers buffers in both directions', async () => {
  const input = new Float32Array([0.5, 1.5, -0.25]);
  const expected = await runDeterministicRapierDrop('worker-golden', input.slice());
  const result = await runRapierTransferProbe('worker-golden', input);
  expect(input.buffer.byteLength).toBe(0);
  expect(result.signature).toBe(expected.signature);
  expect([...result.samples]).toEqual([...expected.samples]);
  expect(result.samples.buffer.byteLength).toBeGreaterThan(0);
});
