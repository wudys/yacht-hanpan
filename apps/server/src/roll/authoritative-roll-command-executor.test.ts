import {
  DICE_SIMULATION_CONTRACT,
  isSimulationOutcome,
  POUR_STYLE,
  type SimulationInput,
} from '@repo/dice-simulation/contract';
import { initializeDeterministicRapierForBun } from '@repo/dice-simulation/rapier/bun';
import { simulateRollOutcome } from '@repo/dice-simulation/simulate';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { createAuthoritativeRollCommandExecutor } from '@/roll/authoritative-roll-command-executor';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import type { ErrorReporter } from '@/runtime/error-reporter';
import { createJsonLogger } from '@/runtime/logger';

const rolledSlots = [0, 2, 4] as const;

describe('authoritative roll command executor', () => {
  test('simulates only the server recipe and returns a compact authoritative artifact', async () => {
    await initializeDeterministicRapierForBun();
    let received: SimulationInput | undefined;
    const lines: string[] = [];
    const executor = createAuthoritativeRollCommandExecutor({
      logger: createJsonLogger((line) => lines.push(line)),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        createRollSeed: () => 'ab'.repeat(32),
        createPourStyle: () => POUR_STYLE.OBLIQUE,
      },
      simulation: {
        execute: async (input) => {
          received = input;
          return await simulateRollOutcome(input);
        },
      },
    });

    const result = await executor.execute({ rolledSlots });

    expect(received).toEqual({
      rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
      seed: 'ab'.repeat(32),
      rolledSlots: [0, 2, 4],
      pourStyle: POUR_STYLE.OBLIQUE,
    });
    expect(result).toMatchObject({
      ok: true,
      artifact: {
        type: 'roll:resolved',
        replay: {
          rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
          rolledSlots: [0, 2, 4],
          contract: {
            simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
          },
        },
      },
    });
    expect(lines).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(
      /"(?:timeline|frames|replayDigest|target\w*)"\s*:/iu,
    );
  });

  test.each(['rollId', 'seed', 'pourStyle', 'rolledSlots', 'outcome'] as const)(
    'fails closed when a compact worker result has a %s mismatch',
    async (mismatch) => {
      const lines: string[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      const executor = createAuthoritativeRollCommandExecutor({
        logger: createJsonLogger((line) => lines.push(line)),
        reportUnexpected: (error, operation) => {
          reports.push([error, operation]);
          throw new Error('diagnostic failure');
        },
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => 'server-roll',
          createRollSeed: () => 'server-seed',
          createPourStyle: () => POUR_STYLE.CLASSIC,
        },
        simulation: {
          execute: async (input) => {
            const changedInput = {
              ...input,
              ...(mismatch === 'rollId' ? { rollId: 'other-roll' } : {}),
              ...(mismatch === 'seed' ? { seed: 'other-seed' } : {}),
              ...(mismatch === 'pourStyle' ? { pourStyle: POUR_STYLE.BURST } : {}),
              ...(mismatch === 'rolledSlots' ? { rolledSlots: [1, 3] as const } : {}),
            };
            const result = {
              input: changedInput,
              authoritativeValuesBySlot: changedInput.rolledSlots.map((slot) => ({
                slot,
                value: 2 as const,
              })),
            };
            if (mismatch === 'outcome') Reflect.deleteProperty(result.authoritativeValuesBySlot, 0);
            expect(isSimulationOutcome(result)).toBe(mismatch !== 'outcome');
            return result;
          },
        },
      });
      expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason: 'unavailable' });
      expect(reports).toHaveLength(1);
      expect(reports[0]?.[0]).toBeInstanceOf(Error);
      expect(reports[0]?.[1]).toBe('roll.result');
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        {
          level: 'error',
          event: 'roll.result.rejected',
          reason: mismatch === 'outcome' ? 'outcome_mismatch' : 'request_mismatch',
        },
      ]);
    },
  );

  test.each([
    [ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY, 'capacity'],
    [ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE, 'unavailable'],
  ] as const)(
    'maps known executor failure %s without duplicate diagnostics',
    async (code, reason) => {
      const lines: string[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      const executor = createAuthoritativeRollCommandExecutor({
        logger: createJsonLogger((line) => lines.push(line)),
        reportUnexpected: (error, operation) => reports.push([error, operation]),
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
          createRollSeed: () => 'ef'.repeat(32),
          createPourStyle: () => POUR_STYLE.CLASSIC,
        },
        simulation: {
          execute: () => Promise.reject(new RollSimulationExecutorError(code)),
        },
      });

      expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason });
      expect(lines).toEqual([]);
      expect(reports).toEqual([]);
    },
  );

  test.each([new Error('private exception detail'), 'private exception detail'])(
    'reports unexpected simulation failure without exception details: %p',
    async (thrown) => {
      const lines: string[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      const executor = createAuthoritativeRollCommandExecutor({
        logger: createJsonLogger((line) => lines.push(line)),
        reportUnexpected: (error, operation) => {
          reports.push([error, operation]);
          throw new Error('diagnostic failure');
        },
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
          createRollSeed: () => 'ef'.repeat(32),
          createPourStyle: () => POUR_STYLE.CLASSIC,
        },
        simulation: { execute: () => Promise.reject(thrown) },
      });

      expect(await executor.execute({ rolledSlots })).toEqual({
        ok: false,
        reason: 'unavailable',
      });
      expect(reports).toEqual([[thrown, 'roll.command']]);
      expect(reports[0]?.[0]).toBe(thrown);
      expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
        {
          level: 'error',
          event: 'roll.command.failed',
          error: thrown instanceof Error ? { name: 'Error' } : null,
        },
      ]);
    },
  );
});
