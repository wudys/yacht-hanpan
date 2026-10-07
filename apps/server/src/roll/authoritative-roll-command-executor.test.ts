import {
  DICE_SIMULATION_CONTRACT,
  isSimulationOutcome,
  POUR_STYLE,
  type RollCandidateEvaluation,
  type RollCandidateRejectionReason,
  type SimulationInput,
} from '@repo/dice-simulation/contract';
import { initializeDeterministicRapierForBun } from '@repo/dice-simulation/rapier/bun';
import { evaluateRollCandidate } from '@repo/dice-simulation/simulate';
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
  test.each(['invalid-result', 'unexpected-error'] as const)(
    'isolates a custom error-only logger failure for %s',
    async (mode) => {
      const reports: Array<Parameters<ErrorReporter>> = [];
      let logs = 0;
      const executor = createAuthoritativeRollCommandExecutor({
        executionBudgetMs: 10_000,
        logger: {
          error() {
            logs += 1;
            throw new Error('diagnostic failure');
          },
        },
        reportUnexpected: (error, operation) => reports.push([error, operation]),
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => 'server-roll',
          createRollSeed: () => 'server-seed',
          createPourStyle: () => POUR_STYLE.CLASSIC,
        },
        simulation: {
          execute: async (input) => {
            if (mode === 'unexpected-error') throw new Error('simulation failure');
            const candidate = accepted(input);
            Reflect.deleteProperty(candidate, 'outcome');
            return candidate;
          },
        },
      });
      expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason: 'unavailable' });
      expect(reports.map(([, operation]) => operation)).toEqual([
        mode === 'invalid-result' ? 'roll.result' : 'roll.command',
      ]);
      expect(logs).toBe(1);
    },
  );

  test('simulates only the server recipe and returns a compact authoritative artifact', async () => {
    await initializeDeterministicRapierForBun();
    let received: SimulationInput | undefined;
    const lines: string[] = [];
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 10_000,
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
          return await evaluateRollCandidate(input);
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

  test('starts its monotonic deadline before recipe preparation', async () => {
    let now = 100;
    let receivedDeadline: number | undefined;
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 100,
      monotonicNow: () => now,
      logger: createJsonLogger(() => {}),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => {
          now += 50;
          return '8184fc0a-4e59-455d-a7c1-579a9ee96403';
        },
        createRollSeed: () => 'budget-seed',
        createPourStyle: () => POUR_STYLE.OBLIQUE,
      },
      simulation: {
        execute: async (input, budget) => {
          receivedDeadline = budget?.deadlineMs;
          return {
            status: 'accepted' as const,
            outcome: {
              input,
              authoritativeValuesBySlot: input.rolledSlots.map((slot) => ({
                slot,
                value: 2 as const,
              })),
            },
          };
        },
      },
    });
    expect(await executor.execute({ rolledSlots })).toMatchObject({ ok: true });
    expect(receivedDeadline).toBe(200);
  });

  test('does not dispatch if recipe preparation exhausts the command budget', async () => {
    let now = 100;
    let dispatched = false;
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 100,
      monotonicNow: () => now,
      logger: createJsonLogger(() => {}),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        createRollSeed: () => {
          now = 200;
          return 'budget-seed';
        },
        createPourStyle: () => POUR_STYLE.OBLIQUE,
      },
      simulation: {
        execute: async (input) => {
          dispatched = true;
          return {
            status: 'accepted' as const,
            outcome: {
              input,
              authoritativeValuesBySlot: input.rolledSlots.map((slot) => ({
                slot,
                value: 2 as const,
              })),
            },
          };
        },
      },
    });
    expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason: 'unavailable' });
    expect(dispatched).toBeFalse();
  });

  test.each([99, 100, 101])(
    'checks the deadline again after an injected executor finishes (%sms)',
    async (elapsed) => {
      let now = 100;
      const reports: Array<Parameters<ErrorReporter>> = [];
      const executor = createAuthoritativeRollCommandExecutor({
        executionBudgetMs: 100,
        monotonicNow: () => now,
        logger: createJsonLogger(() => {}),
        reportUnexpected: (error, operation) => reports.push([error, operation]),
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
          createRollSeed: () => 'budget-seed',
          createPourStyle: () => POUR_STYLE.OBLIQUE,
        },
        simulation: {
          execute: async (input) => {
            now += elapsed;
            return {
              status: 'accepted' as const,
              outcome: {
                input,
                authoritativeValuesBySlot: input.rolledSlots.map((slot) => ({
                  slot,
                  value: 2 as const,
                })),
              },
            };
          },
        },
      });
      const result = await executor.execute({ rolledSlots });
      expect(result.ok).toBe(elapsed < 100);
      expect(reports).toEqual([]);
    },
  );

  test.each(['stable-stack', 'repeated-assist', 'unsettled-at-limit'] as const)(
    'replaces only a rejected seed (%s) and publishes the accepted candidate',
    async (reason) => {
      const inputs: SimulationInput[] = [];
      const deadlines: number[] = [];
      const budgets: unknown[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      let now = 100;
      let identities = 0;
      let styles = 0;
      let seeds = 0;
      const executor = createAuthoritativeRollCommandExecutor({
        executionBudgetMs: 2000,
        monotonicNow: () => now,
        logger: createJsonLogger(() => {}),
        reportUnexpected: (error, operation) => reports.push([error, operation]),
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => {
            identities += 1;
            return '8184fc0a-4e59-455d-a7c1-579a9ee96403';
          },
          createPourStyle: () => {
            styles += 1;
            return POUR_STYLE.BURST;
          },
          createRollSeed: () => `candidate-seed-${++seeds}`,
        },
        simulation: {
          execute: async (input, budget) => {
            inputs.push(input);
            deadlines.push(budget.deadlineMs);
            budgets.push(budget);
            now += 100;
            return inputs.length === 1 ? rejection(input, reason) : accepted(input);
          },
        },
      });
      const result = await executor.execute({ rolledSlots: [1, 4] });
      expect(result).toMatchObject({
        ok: true,
        artifact: {
          replay: {
            seed: 'candidate-seed-2',
            pourStyle: POUR_STYLE.BURST,
            rolledSlots: [1, 4],
          },
        },
      });
      expect(inputs.map(({ seed }) => seed)).toEqual(['candidate-seed-1', 'candidate-seed-2']);
      expect(
        inputs.every(
          (input) => input.rollId === inputs[0]?.rollId && input.pourStyle === POUR_STYLE.BURST,
        ),
      ).toBeTrue();
      expect(identities).toBe(1);
      expect(styles).toBe(1);
      expect(seeds).toBe(2);
      expect(deadlines).toEqual([2100, 2100]);
      expect(budgets[1]).toBe(budgets[0]);
      expect(JSON.stringify(result)).not.toContain('candidate-seed-1');
      expect(JSON.stringify(result)).not.toMatch(
        /"(?:reason|simulationMs|attempts|timeline|frames)"\s*:/,
      );
      expect(reports).toEqual([]);
    },
  );

  test('fails after exactly three rejected candidates without an artifact or diagnostics', async () => {
    let seeds = 0;
    let attempts = 0;
    const reports: Array<Parameters<ErrorReporter>> = [];
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 10_000,
      monotonicNow: () => 0,
      logger: createJsonLogger(() => {}),
      reportUnexpected: (error, operation) => reports.push([error, operation]),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        createPourStyle: () => POUR_STYLE.OBLIQUE,
        createRollSeed: () => `candidate-${++seeds}`,
      },
      simulation: {
        execute: async (input) => {
          attempts += 1;
          return rejection(input);
        },
      },
    });
    expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason: 'unavailable' });
    expect(attempts).toBe(3);
    expect(seeds).toBe(3);
    expect(reports).toEqual([]);
  });

  test('allows the third candidate to succeed after two quality rejections', async () => {
    let seeds = 0;
    let attempts = 0;
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 10_000,
      monotonicNow: () => 0,
      logger: createJsonLogger(() => {}),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        createPourStyle: () => POUR_STYLE.OBLIQUE,
        createRollSeed: () => `candidate-${++seeds}`,
      },
      simulation: {
        execute: async (input) => {
          attempts += 1;
          return attempts === 3 ? accepted(input) : rejection(input);
        },
      },
    });
    expect(await executor.execute({ rolledSlots })).toMatchObject({
      ok: true,
      artifact: { replay: { seed: 'candidate-3' } },
    });
    expect(attempts).toBe(3);
    expect(seeds).toBe(3);
  });

  test.each(['seed', 'reason', 'simulationMs'] as const)(
    'rejects forged quality-rejection %s without regenerating a seed',
    async (mismatch) => {
      let seeds = 0;
      const lines: string[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      const executor = createAuthoritativeRollCommandExecutor({
        executionBudgetMs: 10_000,
        monotonicNow: () => 0,
        logger: createJsonLogger((line) => lines.push(line)),
        reportUnexpected: (error, operation) => reports.push([error, operation]),
        contract: createCompatibilityContract('test-release'),
        recipeSource: {
          createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
          createPourStyle: () => POUR_STYLE.OBLIQUE,
          createRollSeed: () => `candidate-${++seeds}`,
        },
        simulation: {
          execute: async (input) => {
            const result = rejection(input);
            if (mismatch === 'seed')
              Reflect.set(result, 'input', { ...input, seed: 'different-seed' });
            if (mismatch === 'reason') Reflect.set(result, 'reason', 'unsupported');
            if (mismatch === 'simulationMs') Reflect.set(result, 'simulationMs', -1);
            return result;
          },
        },
      });
      expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason: 'unavailable' });
      expect(seeds).toBe(1);
      expect(reports).toHaveLength(1);
      expect(reports[0]?.[1]).toBe('roll.result');
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        {
          level: 'error',
          event: 'roll.result.rejected',
          reason: mismatch === 'seed' ? 'request_mismatch' : 'invalid_candidate',
        },
      ]);
    },
  );

  test('does not generate another seed when a quality rejection exhausts the deadline', async () => {
    let now = 0;
    let seeds = 0;
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 100,
      monotonicNow: () => now,
      logger: createJsonLogger(() => {}),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        createPourStyle: () => POUR_STYLE.OBLIQUE,
        createRollSeed: () => `candidate-${++seeds}`,
      },
      simulation: {
        execute: async (input) => {
          now = 100;
          return rejection(input);
        },
      },
    });
    expect(await executor.execute({ rolledSlots })).toEqual({ ok: false, reason: 'unavailable' });
    expect(seeds).toBe(1);
  });

  test.each([
    ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY,
    ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE,
  ])('does not retry executor failure %s after a quality rejection', async (code) => {
    let seeds = 0;
    let attempts = 0;
    const reports: Array<Parameters<ErrorReporter>> = [];
    const executor = createAuthoritativeRollCommandExecutor({
      executionBudgetMs: 10_000,
      monotonicNow: () => 0,
      logger: createJsonLogger(() => {}),
      reportUnexpected: (error, operation) => reports.push([error, operation]),
      contract: createCompatibilityContract('test-release'),
      recipeSource: {
        createRollId: () => '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        createPourStyle: () => POUR_STYLE.OBLIQUE,
        createRollSeed: () => `candidate-${++seeds}`,
      },
      simulation: {
        execute: async (input) => {
          attempts += 1;
          if (attempts === 2) throw new RollSimulationExecutorError(code);
          return rejection(input);
        },
      },
    });
    expect(await executor.execute({ rolledSlots })).toEqual({
      ok: false,
      reason: code === ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY ? 'capacity' : 'unavailable',
    });
    expect(attempts).toBe(2);
    expect(seeds).toBe(2);
    expect(reports).toEqual([]);
  });

  test.each(['rollId', 'seed', 'pourStyle', 'rolledSlots', 'outcome'] as const)(
    'fails closed when a compact worker result has a %s mismatch',
    async (mismatch) => {
      const lines: string[] = [];
      const reports: Array<Parameters<ErrorReporter>> = [];
      const executor = createAuthoritativeRollCommandExecutor({
        executionBudgetMs: 10_000,
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
            return { status: 'accepted' as const, outcome: result };
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
          reason: mismatch === 'outcome' ? 'invalid_candidate' : 'request_mismatch',
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
        executionBudgetMs: 10_000,
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
        executionBudgetMs: 10_000,
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

function accepted(input: SimulationInput): RollCandidateEvaluation {
  return {
    status: 'accepted',
    outcome: {
      input,
      authoritativeValuesBySlot: input.rolledSlots.map((slot) => ({ slot, value: 2 })),
    },
  };
}
function rejection(
  input: SimulationInput,
  reason: RollCandidateRejectionReason = 'stable-stack',
): RollCandidateEvaluation {
  return { status: 'rejected', input, reason, simulationMs: 2000 };
}
