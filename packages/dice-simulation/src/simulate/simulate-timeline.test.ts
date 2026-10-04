import RAPIER from '@dimforge/rapier3d-deterministic';
import { beforeAll, describe, expect, spyOn, test } from 'bun:test';

import { type DieSlot, POUR_STYLES } from '../contract';
import { DEFAULT_CUP_GEOMETRY } from '../contract/cup-geometry';
import { measurePhysicsCompletion } from '../quality/physical-roll-audit';
import { initializeDeterministicRapierForBun } from '../rapier/bun/initialize-rapier';
import { recognizeTopFace } from './internal/result-recognition';
import { simulateRoll } from './simulate-roll';
import {
  CupReleaseError,
  type PhysicsCompletionSnapshot,
  simulateRollTimeline,
} from './simulate-timeline';

beforeAll(async () => {
  await initializeDeterministicRapierForBun();
});

describe('deterministic physics roll', () => {
  test('fails clearly in a fresh process before runtime initialization', async () => {
    const moduleUrl = new URL('./simulate-timeline.ts', import.meta.url).href;
    const script = [
      `import { simulateRollTimeline } from ${JSON.stringify(moduleUrl)};`,
      "try { simulateRollTimeline({ rollId: 'roll', seed: 'seed', rolledSlots: [0], pourStyle: 'classic' }); }",
      'catch (error) { console.log(error?.code ?? error?.name); }',
    ].join('\n');
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(await new Response(child.stdout).text()).toBe('RAPIER_NOT_READY\n');
    expect(await child.exited).toBe(0);
  });

  test.each(POUR_STYLES)('produces finite slot-aware timelines for %s', (pourStyle) => {
    for (const rolledSlots of [[0], [0, 2, 4], [0, 1, 2, 3, 4]] as const) {
      const timeline = simulateRollTimeline({
        rollId: `roll-${pourStyle}-${rolledSlots.length}`,
        seed: `seed-${pourStyle}-${rolledSlots.length}`,
        rolledSlots,
        pourStyle,
      });

      expect(timeline.dice.map((die) => die.slot)).toEqual([...rolledSlots]);
      expect(timeline.dice).toHaveLength(rolledSlots.length);
      expect('cues' in timeline).toBe(false);
      // Public replay data must not inherit the simulator's private motion parameters.
      expect(Object.keys(timeline.cup).sort()).toEqual([
        'exitAtMs',
        'frames',
        'innerDepth',
        'innerHeight',
        'innerWidth',
        'pourAtMs',
        'releaseAtMs',
        'shakeAmplitude',
        'shakeFrequency',
        'stageX',
        'style',
      ]);
      expect(allTimelineNumbers(timeline)).toBe(true);
      for (const die of timeline.dice) {
        expect(die.value).toBeGreaterThanOrEqual(1);
        expect(die.value).toBeLessThanOrEqual(6);
        expect(die.frames.length).toBeGreaterThan(1);
        expect(recognizeTopFace(die.frames.at(-1)!.q)).toBe(die.value);
      }
    }
  });

  test('reports bounded cup failure progress, frees the world, and permits the next roll', () => {
    const free = spyOn(RAPIER.World.prototype, 'free');
    const createBody = RAPIER.World.prototype.createRigidBody;
    // A physical lid makes failure independent of a formerly unlucky trajectory.
    const lid = spyOn(RAPIER.World.prototype, 'createRigidBody').mockImplementation(function (
      this: RAPIER.World,
      desc: RAPIER.RigidBodyDesc,
    ) {
      const body = createBody.call(this, desc);
      if (body.isKinematic()) {
        this.createCollider(
          RAPIER.ColliderDesc.cylinder(
            0.08,
            DEFAULT_CUP_GEOMETRY.innerRadius + DEFAULT_CUP_GEOMETRY.wallThickness,
          ).setTranslation(0, DEFAULT_CUP_GEOMETRY.innerHeight / 2 + 0.08, 0),
          body,
        );
      }
      return body;
    });
    let failure: unknown;
    try {
      try {
        simulateRollTimeline({
          rollId: 'failed-cup-release',
          seed: 'dice-quality-tuning-burst-5-6',
          rolledSlots: [0, 1, 2, 3, 4],
          pourStyle: 'burst',
        });
      } catch (error) {
        failure = error;
      }
      expect(free).toHaveBeenCalledTimes(1);
      lid.mockRestore();
      const next = simulateRollTimeline({
        rollId: 'after-cup-failure',
        seed: 'seed-classic-1',
        rolledSlots: [0],
        pourStyle: 'classic',
      });
      expect(next.dice).toHaveLength(1);
      expect(free).toHaveBeenCalledTimes(2);
      expect(failure).toBeInstanceOf(Error);
      if (!(failure instanceof CupReleaseError)) throw new Error('Expected cup release failure');
      expect(failure.message).toBe('Cup did not empty through its mouth');
      const { diagnostics } = failure;
      expect(diagnostics.phase).toBe('cup-release');
      expect(diagnostics.totalDice).toBe(5);
      expect(Object.keys(diagnostics).sort()).toEqual([
        'clearedDice',
        'phase',
        'simulationMs',
        'totalDice',
      ]);
      expect(Number.isFinite(diagnostics.simulationMs)).toBe(true);
      expect(diagnostics.simulationMs).toBeGreaterThan(0);
      expect(diagnostics.clearedDice).toBeGreaterThanOrEqual(0);
      expect(diagnostics.clearedDice).toBeLessThanOrEqual(5);
    } finally {
      lid.mockRestore();
      free.mockRestore();
    }
  });

  test('keeps supplied slot identity instead of sorting authoritative results by final x', () => {
    const timeline = simulateRollTimeline({
      rollId: 'roll-slot-order',
      seed: 'gesture-explore-20260921-1',
      rolledSlots: [0, 4],
      pourStyle: 'classic',
    });
    const finalX = timeline.dice.map((die) => die.frames.at(-1)!.p[0]);

    expect(finalX[0]).toBeGreaterThan(finalX[1]);
    expect(timeline.dice.map(({ slot, value }) => ({ slot, value }))).toEqual([
      { slot: 0, value: 1 },
      { slot: 4, value: 5 },
    ]);
  });

  test('rejects external outcomes rather than using them as simulation targets', () => {
    const targetedInput = {
      rollId: 'roll-targeted',
      seed: 'seed-targeted',
      rolledSlots: [0],
      pourStyle: 'classic',
      targetValues: [6],
    };

    expect(() => simulateRollTimeline(targetedInput as never)).toThrow('Invalid simulation input');
  });

  test('physics audit is diagnostic and cannot mutate the roll or its authoritative faces', () => {
    const snapshots: PhysicsCompletionSnapshot[] = [];
    const timeline = simulateRollTimeline(
      {
        rollId: 'roll-quality',
        seed: 'seed-quality',
        rolledSlots: [0, 1, 2, 3, 4],
        pourStyle: 'burst',
      },
      (snapshot) => snapshots.push(snapshot),
    );
    expect(snapshots).toHaveLength(1);
    const raw = snapshots[0];
    const before = structuredClone({ timeline, raw });

    const report = measurePhysicsCompletion(raw, timeline.dice);

    expect(report.facesPreserved).toBe(true);
    expect({ timeline, raw }).toEqual(before);
  });

  test('holds the raw physical result without post-physics translation or rotation', () => {
    const input = {
      rollId: 'raw-rest-audit',
      seed: 'flow-audit-batch-20260918-toss-14',
      rolledSlots: [0, 1, 2, 3, 4] as const,
      pourStyle: 'burst' as const,
    };
    const baseline = simulateRollTimeline(input);
    const snapshots: PhysicsCompletionSnapshot[] = [];
    const audited = simulateRollTimeline(input, (snapshot) => {
      snapshots.push(structuredClone(snapshot));
      // Audit data must not share mutable frame arrays or Rapier bodies with the roll.
      snapshot.dice[0].p[0] = 999;
      snapshot.dice[0].q[0] = 999;
    });

    expect(snapshots).toHaveLength(1);
    expect(audited).toEqual(baseline);
    const raw = snapshots[0];
    expect(raw.dice.map((die) => die.slot)).toEqual([...input.rolledSlots]);
    raw.dice.forEach((die, index) => {
      const replayDie = audited.dice[index];
      expect(replayDie.frames[die.frameIndex]).toMatchObject({ p: die.p, q: die.q });
      expect(die.frameIndex).toBeLessThan(replayDie.frames.length - 1);
      expect(recognizeTopFace(die.q)).toBe(replayDie.value);
      expect(Number.isFinite(die.linearSpeed)).toBe(true);
      expect(Number.isFinite(die.angularSpeed)).toBe(true);
      for (const frame of replayDie.frames.slice(die.frameIndex + 1)) {
        expect(frame.p).toEqual(die.p);
        expect(frame.q).toEqual(die.q);
      }
      expect(replayDie.frames.at(-1)!.t - replayDie.frames[die.frameIndex].t).toBe(250);
    });
  });

  test('returns one immutable authoritative face per requested slot with a full replay digest', async () => {
    const result = await simulateRoll({
      rollId: 'roll-result',
      seed: 'seed-result',
      rolledSlots: [1, 3],
      pourStyle: 'oblique',
    });

    expect(result.authoritativeValuesBySlot).toEqual(
      result.timeline.dice.map(({ slot, value }) => ({ slot, value })),
    );
    expect(result.replayDigest).toMatch(/^sha256-q4-v2:[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.input)).toBe(true);
    expect(Object.isFrozen(result.timeline.dice)).toBe(true);
    expect(Object.isFrozen(result.timeline.dice[0].frames)).toBe(true);
    expect(Object.isFrozen(result.authoritativeValuesBySlot)).toBe(true);
  });
});

function allTimelineNumbers(timeline: ReturnType<typeof simulateRollTimeline>): boolean {
  const values = [
    timeline.durationMs,
    ...timeline.cup.frames.flatMap((frame) => [...frame.p, ...frame.q, frame.t]),
    ...timeline.dice.flatMap((die) =>
      die.frames.flatMap((frame) => [...frame.p, ...frame.q, frame.t]),
    ),
  ];
  return values.every(Number.isFinite);
}

const _slotTypeCheck: readonly DieSlot[] = [0, 1, 2, 3, 4];
void _slotTypeCheck;
