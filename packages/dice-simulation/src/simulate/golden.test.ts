import { beforeAll, describe, expect, test } from 'bun:test';

import type { SimulationInput, SimulationResult } from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { simulateRoll } from './simulate-roll';

interface GoldenCase {
  recipe: SimulationInput;
  expected: {
    authoritativeValuesBySlot: SimulationResult['authoritativeValuesBySlot'];
    replayDigest: string;
    durationMs: number;
    dieFrameCounts: number[];
    cupFrameCount: number;
  };
}

interface GoldenFixture {
  schemaVersion: number;
  cases: GoldenCase[];
}

const fixture = (await Bun.file(
  new URL('../../test/fixtures/golden-rolls.json', import.meta.url),
).json()) as GoldenFixture;

beforeAll(async () => {
  await initializeDeterministicRapierForBun();
});

describe('deterministic golden replay', () => {
  test('uses the framework-neutral fixture schema', () => {
    expect(fixture.schemaVersion).toBe(2);
    expect(fixture.cases).toHaveLength(4);
  });

  for (const golden of fixture.cases) {
    test(`matches reviewed main-thread artifact for ${golden.recipe.rollId}`, async () => {
      const result = await simulateRoll(golden.recipe);
      expect(summarize(result)).toEqual(golden.expected);
    });

    test(`matches full main-thread digest in a Bun worker for ${golden.recipe.rollId}`, async () => {
      const result = await simulateInWorker(golden.recipe);
      expect(result.replayDigest).toBe(golden.expected.replayDigest);
      expect(result.authoritativeValuesBySlot).toEqual(golden.expected.authoritativeValuesBySlot);
    });
  }
});

function summarize(result: SimulationResult): GoldenCase['expected'] {
  return {
    authoritativeValuesBySlot: result.authoritativeValuesBySlot,
    replayDigest: result.replayDigest,
    durationMs: result.timeline.durationMs,
    dieFrameCounts: result.timeline.dice.map((die) => die.frames.length),
    cupFrameCount: result.timeline.cup.frames.length,
  };
}

async function simulateInWorker(recipe: SimulationInput): Promise<SimulationResult> {
  const worker = new Worker(new URL('./golden.test-worker.ts', import.meta.url), {
    type: 'module',
  });
  try {
    return await new Promise<SimulationResult>((resolve, reject) => {
      worker.onmessage = (
        event: MessageEvent<{ ok: true; result: SimulationResult } | { ok: false; error: string }>,
      ) => {
        if (event.data.ok) resolve(event.data.result);
        else reject(new Error(event.data.error));
      };
      worker.onerror = reject;
      worker.postMessage(recipe);
    });
  } finally {
    worker.terminate();
  }
}
