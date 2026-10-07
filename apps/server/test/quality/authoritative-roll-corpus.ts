import { createHash } from 'node:crypto';

import {
  AUTOMATIC_POUR_STYLES,
  isRollCandidateEvaluation,
  type RollCandidateEvaluation,
  type SimulationInput,
} from '@repo/dice-simulation/contract';
import type { CompatibilityContract } from '@repo/game-protocol/version';

import { createAuthoritativeRollCommandExecutor } from '@/roll/authoritative-roll-command-executor';
import {
  type RollSimulationExecutor,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';

export const CORPUS_BUDGETS = { commandMs: 15_000, queueMs: 10_000, jobMs: 10_000 } as const;
export const CORPUS_POOL = { workerCount: 1, maxQueueSize: 128 } as const;

interface CorpusGroup {
  readonly pourStyle: SimulationInput['pourStyle'];
  readonly rolledSlots: SimulationInput['rolledSlots'];
  readonly plannedCommands: number;
}

export interface PlannedRollCommand {
  readonly commandOrdinal: number;
  readonly groupOrdinal: number;
  readonly rollId: string;
  readonly pourStyle: SimulationInput['pourStyle'];
  readonly rolledSlots: SimulationInput['rolledSlots'];
  readonly seedBank: readonly string[];
}

type CandidateObservation =
  | RollCandidateEvaluation
  | Readonly<{ status: 'executor-error'; code: string }>
  | Readonly<{ status: 'invalid-result'; reason: 'candidate-shape' }>;

interface CollectedAttempt {
  readonly attemptOrdinal: number;
  readonly input: SimulationInput;
  readonly elapsedMs: number;
  readonly observation: CandidateObservation;
}

export interface CollectedRollCommand {
  readonly commandOrdinal: number;
  readonly groupOrdinal: number;
  readonly rollId: string;
  readonly seedBank: readonly string[];
  readonly attempts: readonly CollectedAttempt[];
  readonly elapsedMs: number;
  readonly remainingBudgetMs: number | null;
  readonly final:
    | Readonly<{
        status: 'accepted';
        input: SimulationInput;
        authoritativeValuesBySlot: Extract<
          RollCandidateEvaluation,
          { status: 'accepted' }
        >['outcome']['authoritativeValuesBySlot'];
        contract: CompatibilityContract;
      }>
    | Readonly<{ status: 'failed'; reason: 'capacity' | 'unavailable' }>;
}

/** Synthetic banks are fixed before evaluation; production entropy is not used or changed. */
export function createRollCorpusPlan(prefix: string, perGroup: number) {
  if (prefix.length === 0 || prefix.length > 128 || prefix.trim() !== prefix) {
    throw new Error('prefix must contain 1–128 characters without surrounding whitespace');
  }
  if (!Number.isSafeInteger(perGroup) || perGroup < 1 || !Number.isSafeInteger(perGroup * 10)) {
    throw new Error('per-group must be a positive safe integer');
  }
  const groups: CorpusGroup[] = [];
  const commands: PlannedRollCommand[] = [];
  for (const pourStyle of AUTOMATIC_POUR_STYLES) {
    for (let count = 1; count <= 5; count += 1) {
      const rolledSlots = ([0, 1, 2, 3, 4] as const).slice(0, count);
      const groupOrdinal = groups.length;
      groups.push({ pourStyle, rolledSlots, plannedCommands: perGroup });
      for (let sequence = 0; sequence < perGroup; sequence += 1) {
        const coordinate = JSON.stringify([prefix, pourStyle, count, sequence]);
        const identity = sha256(`roll-id:${coordinate}`);
        const rollId = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
        commands.push({
          commandOrdinal: commands.length,
          groupOrdinal,
          rollId,
          pourStyle,
          rolledSlots,
          seedBank: [0, 1, 2].map((attempt) => sha256(`seed:${coordinate}:${attempt}`)),
        });
      }
    }
  }
  // Property insertion order is part of the offline v1 manifest hash contract.
  return { groups, commands, inputManifestSha256: sha256(JSON.stringify(commands)) };
}

export async function collectAuthoritativeRollCommand(
  command: PlannedRollCommand,
  dependencies: Readonly<{
    simulation: RollSimulationExecutor;
    contract: CompatibilityContract;
    monotonicNow?: () => number;
  }>,
): Promise<CollectedRollCommand> {
  const now = dependencies.monotonicNow ?? (() => performance.now());
  const attempts: CollectedAttempt[] = [];
  let commandDeadlineMs: number | null = null;
  let nextSeed = 0;
  const authority = createAuthoritativeRollCommandExecutor({
    contract: dependencies.contract,
    executionBudgetMs: CORPUS_BUDGETS.commandMs,
    monotonicNow: now,
    logger: { error() {} },
    recipeSource: {
      createRollId: () => command.rollId,
      createPourStyle: () => command.pourStyle,
      createRollSeed: () => {
        const seed = command.seedBank[nextSeed++];
        if (seed === undefined) throw new Error('authority exceeded the planned seed bank');
        return seed;
      },
    },
    simulation: {
      execute: async (input, budget) => {
        commandDeadlineMs = budget.deadlineMs;
        const attemptOrdinal = attempts.length;
        const startedAt = now();
        const record = (observation: CandidateObservation): void => {
          attempts.push({
            attemptOrdinal,
            input,
            elapsedMs: Math.max(0, now() - startedAt),
            observation,
          });
        };
        let result: RollCandidateEvaluation;
        try {
          result = await dependencies.simulation.execute(input, budget);
        } catch (error) {
          record({
            status: 'executor-error',
            code: error instanceof RollSimulationExecutorError ? error.code : 'unexpected',
          });
          throw error;
        }
        // Observe only. The real authority still validates shape, identity and deadline.
        record(
          isRollCandidateEvaluation(result)
            ? structuredClone(result)
            : { status: 'invalid-result', reason: 'candidate-shape' },
        );
        return result;
      },
    },
  });
  const startedAt = now();
  const result = await authority.execute({ rolledSlots: command.rolledSlots });
  const completedAt = now();
  const elapsedMs = Math.max(0, completedAt - startedAt);
  return {
    commandOrdinal: command.commandOrdinal,
    groupOrdinal: command.groupOrdinal,
    rollId: command.rollId,
    seedBank: command.seedBank,
    attempts,
    elapsedMs,
    // Observe the authority's actual budget; zero-attempt failures never expose it to the port.
    remainingBudgetMs: commandDeadlineMs === null ? null : commandDeadlineMs - completedAt,
    final: result.ok
      ? {
          status: 'accepted',
          input: {
            rollId: result.artifact.replay.rollId,
            seed: result.artifact.replay.seed,
            pourStyle: result.artifact.replay.pourStyle,
            rolledSlots: result.artifact.replay.rolledSlots,
          },
          authoritativeValuesBySlot: result.artifact.outcome.authoritativeValuesBySlot,
          contract: result.artifact.replay.contract,
        }
      : { status: 'failed', reason: result.reason },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
