import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { type DieSlot, POUR_STYLES, type SimulationInput, SimulationInputError } from '../contract';
import { DEFAULT_CUP_GEOMETRY } from '../contract/cup-geometry';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import * as cupMotion from './internal/cup-motion';
import * as recording from './internal/roll-simulation-constants';
import { simulateRoll, simulateRollOutcome, simulateRollReplay } from './simulate-roll';
import {
  CupReleaseError,
  type PhysicsCompletionSnapshot,
  simulateRollPhysics,
  simulateRollTimeline,
} from './simulate-timeline';

beforeAll(async () => {
  await initializeDeterministicRapierForBun();
});

describe('optional replay recording', () => {
  const inputs: SimulationInput[] = POUR_STYLES.flatMap((pourStyle) =>
    [1, 2, 3, 4, 5].map((count) => ({
      rollId: `recording-parity-${pourStyle}-${count}`,
      seed: `recording-parity-${pourStyle}-${count}`,
      rolledSlots:
        count === 3 ? [0, 2, 4] : Array.from({ length: count }, (_, index) => index as DieSlot),
      pourStyle,
    })),
  );
  inputs.push(
    ...[
      ['classic', 'flow-audit-batch-20260918-classic-103'],
      ['burst', 'flow-audit-batch-20260918-toss-14'],
      ['oblique', 'flow-audit-batch-20260918-ricochet-397'],
    ].map(([pourStyle, seed]) => ({
      rollId: `recording-regression-${pourStyle}`,
      seed,
      rolledSlots: [0, 1, 2, 3, 4] as const,
      pourStyle: pourStyle as SimulationInput['pourStyle'],
    })),
  );

  for (const input of inputs) {
    test(`preserves raw completion and physics steps for ${input.rollId}`, async () => {
      const traces: ReturnType<typeof captureTrace>[] = [];
      let steps = 0;
      const cupRemovals: { step: number; p: RAPIER.Vector; q: RAPIER.Rotation }[] = [];
      const originalStep = RAPIER.World.prototype.step;
      const originalFree = RAPIER.World.prototype.free;
      const originalRemoveBody = RAPIER.World.prototype.removeRigidBody;
      const stepSpy = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
        this: RAPIER.World,
        ...args: Parameters<RAPIER.World['step']>
      ) {
        steps += 1;
        return originalStep.apply(this, args);
      });
      const removeSpy = spyOn(RAPIER.World.prototype, 'removeRigidBody').mockImplementation(
        function (this: RAPIER.World, body: RAPIER.RigidBody) {
          if (body.isKinematic())
            cupRemovals.push({ step: steps, p: body.translation(), q: body.rotation() });
          return originalRemoveBody.call(this, body);
        },
      );
      const freeSpy = spyOn(RAPIER.World.prototype, 'free').mockImplementation(function (
        this: RAPIER.World,
      ) {
        traces.push(captureTrace(this, steps, cupRemovals));
        steps = 0;
        cupRemovals.length = 0;
        return originalFree.call(this);
      });
      let completion: PhysicsCompletionSnapshot | undefined;
      try {
        const timeline = simulateRollTimeline(input, (snapshot) => {
          completion = snapshot;
        });
        const replay = await simulateRollReplay(input);
        const outcome = await simulateRollOutcome(input);
        expect(replay.timeline).toEqual(timeline);
        expect(outcome.authoritativeValuesBySlot).toEqual(replay.authoritativeValuesBySlot);
        expect(replay.authoritativeValuesBySlot).toEqual(
          timeline.dice.map(({ slot, value }) => ({ slot, value })),
        );
        expect(traces).toHaveLength(3);
        expect(traces[1]).toEqual(traces[0]);
        expect(traces[2]).toEqual(traces[0]);
        expect(completion).toBeDefined();
        expect(completion!.simulationMs).toBe(timeline.dice[0].frames.at(-1)!.t - 250);
        expect(Object.keys(outcome).sort()).toEqual(['authoritativeValuesBySlot', 'input']);
      } finally {
        stepSpy.mockRestore();
        removeSpy.mockRestore();
        freeSpy.mockRestore();
      }
    });
  }

  test('recording density changes frames without changing physical completion', () => {
    const cadence = spyOn(recording, 'timelineSampleEverySteps');
    const originalFree = RAPIER.World.prototype.free;
    const originalStep = RAPIER.World.prototype.step;
    const originalRemove = RAPIER.World.prototype.removeRigidBody;
    let steps = 0;
    const cupRemovals: number[] = [];
    const traces: ReturnType<typeof captureTrace>[] = [];
    const stepSpy = spyOn(RAPIER.World.prototype, 'step').mockImplementation(function (
      this: RAPIER.World,
      ...args: Parameters<RAPIER.World['step']>
    ) {
      steps += 1;
      return originalStep.apply(this, args);
    });
    const removeSpy = spyOn(RAPIER.World.prototype, 'removeRigidBody').mockImplementation(function (
      this: RAPIER.World,
      body: RAPIER.RigidBody,
    ) {
      if (body.isKinematic()) cupRemovals.push(steps);
      return originalRemove.call(this, body);
    });
    const freeSpy = spyOn(RAPIER.World.prototype, 'free').mockImplementation(function (
      this: RAPIER.World,
    ) {
      traces.push(captureTrace(this, steps, cupRemovals));
      steps = 0;
      cupRemovals.length = 0;
      return originalFree.call(this);
    });
    const cadenceInputs: SimulationInput[] = [...inputs];
    for (const pourStyle of ['burst', 'oblique'] as const) {
      for (let count = 1; count <= 5; count += 1) {
        for (let sequence = 0; sequence < 10; sequence += 1) {
          const seed = `cadence-audit-${pourStyle}-${count}-${sequence}`;
          cadenceInputs.push({
            rollId: seed,
            seed,
            pourStyle,
            rolledSlots: Array.from({ length: count }, (_, slot) => slot as DieSlot),
          });
        }
      }
    }
    cadenceInputs.push({
      rollId: 'cadence-rejected-candidate',
      seed: '33c68b4b286444fed0f281a79f85f714',
      pourStyle: 'burst',
      rolledSlots: [0, 1, 2, 3],
    });
    let changedFrameCount = false;
    try {
      for (const input of cadenceInputs) {
        cadence.mockReturnValue(2);
        const sparse = simulateRollPhysics(input, true);
        cadence.mockReturnValue(1);
        const dense = simulateRollPhysics(input, true);
        expect(traces.at(-1)).toEqual(traces.at(-2));
        expect(dense.status).toBe(sparse.status);
        if (sparse.status === 'rejected' || dense.status === 'rejected') {
          expect(dense).toEqual(sparse);
          continue;
        }
        expect(dense.replay.authoritativeValuesBySlot).toEqual(
          sparse.replay.authoritativeValuesBySlot,
        );
        expect(dense.replay.timeline.durationMs).toBe(sparse.replay.timeline.durationMs);
        expect(dense.replay.timeline.cup.releaseAtMs).toBe(sparse.replay.timeline.cup.releaseAtMs);
        changedFrameCount ||=
          dense.replay.timeline.dice[0].frames.length >
          sparse.replay.timeline.dice[0].frames.length;
      }
      expect(changedFrameCount).toBe(true);
    } finally {
      cadence.mockRestore();
      stepSpy.mockRestore();
      removeSpy.mockRestore();
      freeSpy.mockRestore();
    }
  });

  test('does not construct cup display frames without recording', async () => {
    const frameSpy = spyOn(cupMotion, 'createCupFrame');
    const input = inputs[0];
    try {
      await simulateRollOutcome(input);
      expect(frameSpy).not.toHaveBeenCalled();
      const replay = await simulateRollReplay(input);
      expect(frameSpy).toHaveBeenCalledTimes(replay.timeline.cup.frames.length);
    } finally {
      frameSpy.mockRestore();
    }
  });

  test('validates every public entry before allocating a world', async () => {
    const create = spyOn(RAPIER.World.prototype, 'createRigidBody');
    try {
      for (const simulator of [simulateRoll, simulateRollReplay, simulateRollOutcome]) {
        for (const input of [
          { ...inputs[0], targetValues: [6] },
          { ...inputs[0], rolledSlots: [2, 0] },
          { ...inputs[0], rolledSlots: Array(1) },
          { ...inputs[0], seed: '' },
        ]) {
          await expect(simulator(input as never)).rejects.toBeInstanceOf(SimulationInputError);
        }
      }
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
    }
  });

  test('owns each result and keeps legacy diagnostic replay deeply immutable', async () => {
    const input = { ...inputs[0], rolledSlots: [0] as DieSlot[] };
    const replay = await simulateRollReplay(input);
    const expected = structuredClone(replay);
    const outcome = await simulateRollOutcome(input);
    input.rolledSlots[0] = 4;
    replay.timeline.dice[0].frames[0].p[0] = 999;
    const next = await simulateRollReplay(expected.input);
    expect(next).toEqual(expected);
    expect(outcome.input).toEqual(expected.input);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.authoritativeValuesBySlot[0])).toBe(true);
    expect(Object.isFrozen(replay.timeline.dice[0].frames)).toBe(false);
    const legacy = await simulateRoll(expected.input);
    expect(legacy.timeline).toEqual(expected.timeline);
    expect(Object.isFrozen(legacy.timeline.dice[0].frames[0].p)).toBe(true);
  });

  test('frees a blocked world in both recording modes and permits the next roll', async () => {
    const originalCreateBody = RAPIER.World.prototype.createRigidBody;
    const create = spyOn(RAPIER.World.prototype, 'createRigidBody').mockImplementation(function (
      this: RAPIER.World,
      desc: RAPIER.RigidBodyDesc,
    ) {
      const body = originalCreateBody.call(this, desc);
      if (body.isKinematic())
        this.createCollider(
          RAPIER.ColliderDesc.cylinder(
            0.08,
            DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness,
          ).setTranslation(0, DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.08, 0),
          body,
        );
      return body;
    });
    const free = spyOn(RAPIER.World.prototype, 'free');
    try {
      for (const simulator of [simulateRollOutcome, simulateRollReplay]) {
        await expect(simulator(inputs[0])).rejects.toBeInstanceOf(CupReleaseError);
      }
      expect(free).toHaveBeenCalledTimes(2);
      create.mockRestore();
      expect((await simulateRollOutcome(inputs[0])).authoritativeValuesBySlot).toHaveLength(1);
      expect(free).toHaveBeenCalledTimes(3);
    } finally {
      create.mockRestore();
      free.mockRestore();
    }
  });
});

function captureTrace(world: RAPIER.World, steps: number, cupRemovals: readonly unknown[]) {
  const dice: {
    p: RAPIER.Vector;
    q: RAPIER.Rotation;
    linear: RAPIER.Vector;
    angular: RAPIER.Vector;
  }[] = [];
  world.forEachRigidBody((body) => {
    if (body.isDynamic())
      dice.push({
        p: body.translation(),
        q: body.rotation(),
        linear: body.linvel(),
        angular: body.angvel(),
      });
  });
  return { steps, cupRemovals: [...cupRemovals], dice };
}
