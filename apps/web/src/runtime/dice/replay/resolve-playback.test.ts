import { simulateRollReplay } from '@repo/dice-simulation';
import {
  POUR_STYLE,
  type SimulationInput,
  type SimulationReplay,
} from '@repo/dice-simulation/contract';
import { SimulationRejectedError } from '@repo/dice-simulation/simulate';
import { describe, expect, test, vi } from 'vitest';

import {
  type ResolvedRollPlaybackArtifact,
  resolveRollPlayback,
} from '@/runtime/dice/replay/resolve-playback';

// These tests inject simulation results; real WASM replay is covered by product integration.
vi.mock('@repo/dice-simulation', () => ({
  simulateRollReplay: vi.fn(),
}));

const artifact: ResolvedRollPlaybackArtifact = {
  replay: {
    rollId: 'roll-1',
    seed: 'server-seed',
    pourStyle: POUR_STYLE.CLASSIC,
    rolledSlots: [0, 2],
  },
  outcome: {
    authoritativeValuesBySlot: [
      { slot: 0, value: 2 },
      { slot: 2, value: 5 },
    ],
  },
};

function result(input: SimulationInput): SimulationReplay {
  return {
    input,
    authoritativeValuesBySlot: artifact.outcome.authoritativeValuesBySlot,
    timeline: {
      rollId: input.rollId,
      seed: input.seed,
      durationMs: 100,
      rollArea: { width: 8, depth: 10, aspectRatio: 0.8 },
      cup: {
        style: input.pourStyle,
        shakeAmplitude: 1,
        shakeFrequency: 1,
        pourAtMs: 10,
        releaseAtMs: 20,
        exitAtMs: 30,
        innerWidth: 1,
        innerDepth: 1,
        innerHeight: 1,
        frames: [],
      },
      dice: artifact.outcome.authoritativeValuesBySlot.map(({ slot, value }) => ({
        slot,
        value,
        frames: [{ t: 0, p: [slot, 0, 0], q: [0, 0, 0, 1] }],
      })),
    },
  };
}

describe('resolveRollPlayback', () => {
  test('passes only replay recipe fields to the simulator', async () => {
    const simulator = vi.fn(async (input: SimulationInput) => result(input));
    const playback = await resolveRollPlayback(artifact, simulator);

    expect(simulator).toHaveBeenCalledTimes(1);
    expect(simulator).toHaveBeenCalledWith({
      rollId: 'roll-1',
      seed: 'server-seed',
      rolledSlots: [0, 2],
      pourStyle: POUR_STYLE.CLASSIC,
    });
    expect(playback.status).toBe('verified');
  });

  test('outcome changes cannot affect simulation and select static fallback', async () => {
    const changed = {
      ...artifact,
      outcome: {
        authoritativeValuesBySlot: [
          { slot: 0, value: 6 },
          { slot: 2, value: 1 },
        ],
      },
    } satisfies ResolvedRollPlaybackArtifact;
    const simulator = vi.fn(async (input: SimulationInput) => result(input));
    const playback = await resolveRollPlayback(changed, simulator);

    expect(simulator.mock.calls[0]?.[0]).not.toHaveProperty('authoritativeValuesBySlot');
    expect(playback).toMatchObject({
      status: 'static-fallback',
      reason: 'OUTCOME_MISMATCH',
      dice: [
        { slot: 0, value: 6 },
        { slot: 2, value: 1 },
      ],
    });
    if (playback.status === 'static-fallback') {
      expect(playback.dice).toEqual(changed.outcome.authoritativeValuesBySlot);
      expect(playback.dice[0]).not.toHaveProperty('p');
      expect(playback.dice[0]).not.toHaveProperty('q');
    }
  });

  test('uses the replay API without requiring a diagnostic digest', async () => {
    vi.mocked(simulateRollReplay).mockImplementationOnce(async (input) => result(input));
    const playback = await resolveRollPlayback(artifact);

    expect(playback.status).toBe('verified');
    expect(simulateRollReplay).toHaveBeenCalledWith(artifact.replay);
  });

  test.each([
    { faces: [{ slot: 0, value: 2 }] },
    {
      faces: [
        { slot: 0, value: 2 },
        { slot: 2, value: 5 },
        { slot: 4, value: 1 },
      ],
    },
    {
      faces: [
        { slot: 0, value: 2 },
        { slot: 1, value: 5 },
      ],
    },
    {
      faces: [
        { slot: 2, value: 5 },
        { slot: 0, value: 2 },
      ],
    },
    {
      faces: [
        { slot: 0, value: 2 },
        { slot: 0, value: 5 },
      ],
    },
  ] satisfies { faces: SimulationReplay['authoritativeValuesBySlot'] }[])(
    'rejects mismatched ordered slots %j',
    async ({ faces }) => {
      const playback = await resolveRollPlayback(artifact, async (input) => ({
        ...result(input),
        authoritativeValuesBySlot: faces,
      }));

      expect(playback).toMatchObject({
        status: 'static-fallback',
        reason: 'OUTCOME_MISMATCH',
        dice: artifact.outcome.authoritativeValuesBySlot,
      });
      expect(playback).not.toHaveProperty('timeline');
    },
  );

  test('simulation failures preserve the authoritative static outcome', async () => {
    const cause = new WebAssembly.RuntimeError('WASM failed');
    const playback = await resolveRollPlayback(artifact, () => Promise.reject(cause));
    expect(playback).toMatchObject({
      status: 'static-fallback',
      reason: 'SIMULATION_FAILED',
      cause,
    });
    if (playback.status === 'static-fallback') expect(playback.cause).toBe(cause);
  });

  test('a locally rejected candidate preserves authority without retrying or replacing the seed', async () => {
    const cause = new SimulationRejectedError({ reason: 'repeated-assist', simulationMs: 3300 });
    const simulator = vi.fn(() => Promise.reject(cause));
    const original = structuredClone(artifact);

    const playback = await resolveRollPlayback(artifact, simulator);

    expect(simulator).toHaveBeenCalledExactlyOnceWith(artifact.replay);
    expect(artifact).toEqual(original);
    expect(playback).toEqual({
      status: 'static-fallback',
      rollId: artifact.replay.rollId,
      reason: 'SIMULATION_FAILED',
      cause,
      dice: artifact.outcome.authoritativeValuesBySlot,
    });
    expect(playback).not.toHaveProperty('timeline');
  });
});
