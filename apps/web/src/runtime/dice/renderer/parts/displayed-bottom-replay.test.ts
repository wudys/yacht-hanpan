import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { simulateRollReplay } from '@repo/dice-simulation';
import {
  DEFAULT_CUP_GEOMETRY,
  DIE_GEOMETRY,
  type SimulationInput,
} from '@repo/dice-simulation/contract';
import { initializeDeterministicRapierForBrowser } from '@repo/dice-simulation/rapier/browser';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { beforeAll, describe, expect, test, vi } from 'vitest';

import {
  baseFootprint,
  displayedBottomDepth,
} from '@/runtime/dice/renderer/parts/displayed-bottom.test-support';
import {
  sampleCupFrames,
  sampleDieFrames,
  type TimelineSample,
} from '@/runtime/dice/renderer/parts/timeline-sampling';
import type { CanvasFactory } from '@/runtime/dice/resources/canvas-factory';
import { createProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

// These four recipes had the greatest bottom overlap in the earlier candidate
// audit. Checking product meshes and the public sampler catches replay exposure
// that a raw physics contact-distance test cannot establish.
const riskInputs: SimulationInput[] = [
  {
    rollId: 'golden-burst-5',
    seed: 'golden-burst-5',
    rolledSlots: [0, 1, 2, 3, 4],
    pourStyle: 'burst',
  },
  {
    rollId: 'challenge-supported-burst4',
    seed: 'dice-quality-tuning-burst-4-1',
    rolledSlots: [0, 1, 2, 3],
    pourStyle: 'burst',
  },
  {
    rollId: 'golden-classic-5',
    seed: 'golden-classic-5',
    rolledSlots: [0, 1, 2, 3, 4],
    pourStyle: 'classic',
  },
  {
    rollId: 'golden-classic-3',
    seed: 'bench-classic-3-b',
    rolledSlots: [0, 2, 4],
    pourStyle: 'classic',
  },
];

const createCanvas = ((width: number, height: number) => ({
  width,
  height,
  getContext: () => ({ fillStyle: '', fillRect() {}, beginPath() {}, arc() {}, fill() {} }),
})) as unknown as CanvasFactory;

function poseMatrix(sample: TimelineSample, scale: number = 1): Matrix4 {
  return new Matrix4().compose(
    new Vector3(...sample.p),
    new Quaternion(...sample.q),
    new Vector3(scale, scale, scale),
  );
}

function fullyAboveMouth(dieMatrix: Matrix4, cupMatrix: Matrix4): boolean {
  const relative = cupMatrix.clone().invert().multiply(dieMatrix);
  // The unrounded unit box encloses the entire rendered/physical die. This
  // stricter clearance only excludes a die once even that bound has passed
  // the mouth, so a base escape cannot exempt itself as a normal mouth exit.
  for (const x of [-0.5, 0.5]) {
    for (const y of [-0.5, 0.5]) {
      for (const z of [-0.5, 0.5]) {
        if (
          new Vector3(x, y, z).applyMatrix4(relative).y <=
          DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.005
        )
          return false;
      }
    }
  }
  return true;
}

describe('product replay displayed bottom', () => {
  beforeAll(async () => {
    // Read the installed dependency asset through its owning package. The real
    // browser loader and simulator run unchanged; only HTTP delivery is local.
    const require = createRequire(import.meta.url);
    const simulationRequire = createRequire(require.resolve('@repo/dice-simulation'));
    const wasm = await readFile(
      simulationRequire.resolve('@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm'),
    );
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(wasm).buffer));
    try {
      await initializeDeterministicRapierForBrowser('test-local-rapier.wasm');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test.each(riskInputs)(
    '$seed stays above the external base before mouth clearance',
    async (input) => {
      const { timeline } = await simulateRollReplay(input);
      const resources = createProceduralDiceResources(createCanvas);
      try {
        resources.cup.geometry.base.computeBoundingBox();
        const baseBounds = resources.cup.geometry.base.boundingBox!;
        const outerBottomY =
          baseBounds.min.y -
          DEFAULT_CUP_GEOMETRY.innerHeight / 2 -
          DEFAULT_CUP_GEOMETRY.baseThickness / 2;
        const footprint = baseFootprint(resources.cup.geometry.base);
        const savedTimes = new Set([
          ...timeline.cup.frames.map((frame) => frame.t),
          ...timeline.dice.flatMap((die) => die.frames.map((frame) => frame.t)),
        ]);
        const times = new Set([...savedTimes].filter((time) => time <= timeline.cup.releaseAtMs));
        // 240 Hz covers both saved frames and interpolation during shake/pour.
        // This bounded sampling does not claim continuous collision proof.
        for (let time = 0; time <= timeline.cup.releaseAtMs; time += 1000 / 240) times.add(time);
        const exited = new Set<number>();
        let savedSamples = 0;
        let interpolatedSamples = 0;
        let pourSamples = 0;
        let worst = { depth: 0, slot: -1, timeMs: -1 };
        for (const timeMs of [...times].sort((a, b) => a - b)) {
          const cupSample = sampleCupFrames(timeline.cup.frames, timeMs);
          const cupMatrix = poseMatrix(cupSample);
          for (const die of timeline.dice) {
            if (exited.has(die.slot)) continue;
            const dieSample = sampleDieFrames(die.frames, timeMs);
            const dieMatrix = poseMatrix(dieSample, DIE_GEOMETRY.size);
            if (timeMs >= timeline.cup.pourAtMs && fullyAboveMouth(dieMatrix, cupMatrix)) {
              exited.add(die.slot);
              continue;
            }
            if (!cupSample.visible || !dieSample.visible) continue;
            if (savedTimes.has(timeMs)) savedSamples += 1;
            else interpolatedSamples += 1;
            if (timeMs >= timeline.cup.pourAtMs) pourSamples += 1;
            const depth = displayedBottomDepth(
              resources.dieGeometry,
              dieMatrix,
              cupMatrix,
              footprint,
              outerBottomY,
            );
            if (depth > worst.depth) worst = { depth, slot: die.slot, timeMs };
          }
        }
        expect(savedSamples).toBeGreaterThan(0);
        expect(interpolatedSamples).toBeGreaterThan(0);
        expect(pourSamples).toBeGreaterThan(0);
        // Only numerical transform/Float32 noise is tolerated, not contact depth
        // or half the base thickness. Failure reports the reproducible pose time.
        expect(worst.depth, JSON.stringify({ input, worst })).toBeLessThanOrEqual(1e-6);
      } finally {
        resources.dispose();
      }
    },
  );
});
