import {
  DICE_SIMULATION_CONTRACT,
  POUR_STYLE,
  type SimulationInput,
  type SimulationResult,
} from '@repo/dice-simulation/contract';
import { describe, expect, test, vi } from 'vitest';

import {
  type ResolvedRollPlaybackArtifact,
  resolveRollPlayback,
} from '@/runtime/dice/replay/resolve-playback';

// These tests inject simulation results; real WASM replay is covered by product integration.
vi.mock('@repo/dice-simulation', () => ({
  simulateRoll: () => {
    throw new Error('Use the injected simulation fixture');
  },
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
  replayDigest: `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${'a'.repeat(64)}`,
};

function result(input: SimulationInput, digest: string = artifact.replayDigest): SimulationResult {
  return {
    input,
    authoritativeValuesBySlot: artifact.outcome.authoritativeValuesBySlot,
    replayDigest: digest,
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

  test('digest mismatch never face-forces the reconstructed timeline', async () => {
    const playback = await resolveRollPlayback(artifact, async (input) =>
      result(input, 'sha256:bad'),
    );
    expect(playback).toMatchObject({ status: 'static-fallback', reason: 'DIGEST_MISMATCH' });
    expect(playback).not.toHaveProperty('timeline');
  });

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
});
