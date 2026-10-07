import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RollCandidateEvaluation, SimulationInput } from '@repo/dice-simulation/contract';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { RollSimulationExecutorError } from '@/roll/roll-simulation-executor';

import { collectAuthoritativeRollCommand, createRollCorpusPlan } from './authoritative-roll-corpus';

const contract = createCompatibilityContract('roll-corpus-test');
const plan = createRollCorpusPlan('collector-regression', 1);
const command = plan.commands[0]!;

const accepted = (input: SimulationInput): RollCandidateEvaluation => ({
  status: 'accepted',
  outcome: {
    input,
    authoritativeValuesBySlot: input.rolledSlots.map((slot) => ({ slot, value: 4 })),
  },
});

describe('authoritative roll corpus', () => {
  test('preplans stable banks for every automatic style and dice count', () => {
    expect(plan.groups).toHaveLength(10);
    expect(plan.commands).toHaveLength(10);
    expect(new Set(plan.commands.map(({ rollId }) => rollId)).size).toBe(10);
    expect(new Set(plan.commands.flatMap(({ seedBank }) => seedBank)).size).toBe(30);
    expect(createRollCorpusPlan('collector-regression', 1)).toEqual(plan);
    expect(createRollCorpusPlan('another-prefix', 1).inputManifestSha256).not.toBe(
      plan.inputManifestSha256,
    );
    expect(() => createRollCorpusPlan('', 1)).toThrow();
    expect(() => createRollCorpusPlan('valid', 0)).toThrow();
  });

  test('records the actual authority retry and final artifact without inventing a third attempt', async () => {
    const requests: SimulationInput[] = [];
    const deadlines: number[] = [];
    let now = 0;
    const sample = await collectAuthoritativeRollCommand(command, {
      contract,
      monotonicNow: () => now,
      simulation: {
        execute: async (input, budget) => {
          requests.push(input);
          deadlines.push(budget.deadlineMs);
          now += 5;
          return requests.length === 1
            ? { status: 'rejected', input, reason: 'stable-stack', simulationMs: 1200 }
            : accepted(input);
        },
      },
    });
    expect(sample.attempts.map(({ observation }) => observation.status)).toEqual([
      'rejected',
      'accepted',
    ]);
    expect(requests.map(({ seed }) => seed)).toEqual(command.seedBank.slice(0, 2));
    expect(requests[1]).toEqual({ ...requests[0]!, seed: command.seedBank[1]! });
    expect(deadlines).toEqual([15_000, 15_000]);
    expect(sample.final).toEqual({
      status: 'accepted',
      input: requests[1],
      contract,
      authoritativeValuesBySlot: [{ slot: 0, value: 4 }],
    });
    expect(sample.elapsedMs).toBe(10);
  });

  test('keeps all three physical rejections and a failed final without faces', async () => {
    const sample = await collectAuthoritativeRollCommand(command, {
      contract,
      simulation: {
        execute: async (input) => ({
          status: 'rejected',
          input,
          reason: 'repeated-assist',
          simulationMs: 2100,
        }),
      },
    });
    expect(sample.attempts.map(({ attemptOrdinal }) => attemptOrdinal)).toEqual([0, 1, 2]);
    expect(sample.final).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  test('capacity and malformed responses remain failed commands, not replacement candidates', async () => {
    const capacity = await collectAuthoritativeRollCommand(command, {
      contract,
      simulation: {
        execute: async () => {
          throw new RollSimulationExecutorError('CAPACITY');
        },
      },
    });
    expect(capacity.attempts).toHaveLength(1);
    expect(capacity.attempts[0]!.observation).toEqual({
      status: 'executor-error',
      code: 'CAPACITY',
    });
    expect(capacity.final).toEqual({ status: 'failed', reason: 'capacity' });

    const malformed = await collectAuthoritativeRollCommand(command, {
      contract,
      simulation: {
        execute: async () => ({ status: 'broken' }) as unknown as RollCandidateEvaluation,
      },
    });
    expect(malformed.attempts).toHaveLength(1);
    expect(malformed.attempts[0]!.observation).toEqual({
      status: 'invalid-result',
      reason: 'candidate-shape',
    });
    expect(malformed.final).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  test('preserves an accepted port result that missed the authority deadline', async () => {
    let now = 0;
    const sample = await collectAuthoritativeRollCommand(command, {
      contract,
      monotonicNow: () => now,
      simulation: {
        execute: async (input) => {
          now = 15_000;
          return accepted(input);
        },
      },
    });
    expect(sample.attempts[0]!.observation.status).toBe('accepted');
    expect(sample.final).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  test('records an expired third rejection separately from completion within the budget', async () => {
    let now = 0;
    let attempt = 0;
    const sample = await collectAuthoritativeRollCommand(command, {
      contract,
      monotonicNow: () => now,
      simulation: {
        execute: async (input) => {
          now = ++attempt === 3 ? 15_000 : attempt;
          return { status: 'rejected', input, reason: 'stable-stack', simulationMs: 1200 };
        },
      },
    });
    expect(sample.attempts).toHaveLength(3);
    expect(sample).toMatchObject({
      remainingBudgetMs: 0,
      final: { status: 'failed', reason: 'unavailable' },
    });
  });

  test('retains a command whose budget expires before its first candidate', async () => {
    let reads = 0;
    let calls = 0;
    const sample = await collectAuthoritativeRollCommand(command, {
      contract,
      monotonicNow: () => (++reads < 3 ? 0 : 15_000),
      simulation: {
        execute: async (input) => {
          calls += 1;
          return accepted(input);
        },
      },
    });
    expect(calls).toBe(0);
    expect(sample.attempts).toEqual([]);
    expect(sample.final).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  test('records unexpected port failures without persisting their raw diagnostics', async () => {
    const sample = await collectAuthoritativeRollCommand(command, {
      contract,
      simulation: {
        execute: async () => {
          throw new Error('synthetic-private-diagnostic');
        },
      },
    });
    expect(sample.attempts[0]!.observation).toEqual({
      status: 'executor-error',
      code: 'unexpected',
    });
    expect(JSON.stringify(sample)).not.toContain('synthetic-private-diagnostic');
    expect(sample.final).toEqual({ status: 'failed', reason: 'unavailable' });
  });

  test('the CLI rejects invalid arguments and cannot overwrite an earlier corpus', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'roll-corpus-cli-'));
    const output = join(directory, 'existing.json');
    const script = fileURLToPath(new URL('./sample-roll-outcomes.ts', import.meta.url));
    try {
      await writeFile(output, 'original evidence');
      const invalid = Bun.spawn([process.execPath, script, '--per-group', '0'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      expect(await invalid.exited).toBe(1);
      expect(await new Response(invalid.stderr).text()).toContain('sample:roll-outcomes');
      const existing = Bun.spawn(
        [process.execPath, script, '--prefix', 'cli-test', '--per-group', '1', '--output', output],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      expect(await existing.exited).toBe(1);
      expect(await new Response(existing.stderr).text()).toContain('EEXIST');
      expect(await readFile(output, 'utf8')).toBe('original evidence');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('the CLI writes an incomplete record when provenance initialization fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'roll-corpus-initialization-'));
    const output = join(directory, 'incomplete.json');
    const script = fileURLToPath(new URL('./sample-roll-outcomes.ts', import.meta.url));
    try {
      const child = Bun.spawn(
        [process.execPath, script, '--prefix', 'cli-init', '--per-group', '1', '--output', output],
        {
          env: { ...process.env, PATH: directory },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(await child.exited).toBe(1);
      const result = JSON.parse(await readFile(output, 'utf8')) as Record<string, unknown>;
      expect(result).toMatchObject({
        kind: 'authoritative-roll-corpus',
        schemaVersion: 1,
        completed: false,
        provenance: null,
        failure: 'initialization',
        commands: [],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
