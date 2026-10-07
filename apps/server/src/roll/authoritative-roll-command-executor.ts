import {
  isRollCandidateEvaluation,
  parseSimulationInput,
  type PourStyle,
  type RollCandidateEvaluation,
  type SimulationInput,
} from '@repo/dice-simulation/contract';
import { parseResolvedRollArtifact, RESOLVED_ROLL_TYPE } from '@repo/game-protocol/socket';
import type { CompatibilityContract } from '@repo/game-protocol/version';

import type {
  RollCommandExecution,
  RollCommandExecutionInput,
  RollCommandExecutor,
} from '@/roll/roll-command-executor';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  type RollSimulationExecutor,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import { type Logger, protectLogger } from '@/runtime/logger';

export interface RollRecipeSource {
  readonly createRollId: () => string;
  readonly createRollSeed: () => string;
  readonly createPourStyle: () => PourStyle;
}

const MAX_ROLL_CANDIDATE_ATTEMPTS = 3;

interface AuthoritativeRollCommandExecutorDependencies {
  readonly contract: CompatibilityContract;
  readonly executionBudgetMs: number;
  readonly monotonicNow?: () => number;
  readonly logger: Pick<Logger, 'error'>;
  readonly reportUnexpected?: ErrorReporter;
  readonly recipeSource: RollRecipeSource;
  readonly simulation: RollSimulationExecutor;
}

export function createAuthoritativeRollCommandExecutor(
  dependencies: AuthoritativeRollCommandExecutorDependencies,
): RollCommandExecutor {
  if (!Number.isSafeInteger(dependencies.executionBudgetMs) || dependencies.executionBudgetMs < 1) {
    throw new Error('invalid roll execution budget');
  }
  const monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  const logger = protectLogger(dependencies.logger);
  return {
    async execute({ rolledSlots }: RollCommandExecutionInput): Promise<RollCommandExecution> {
      const budget = { deadlineMs: monotonicNow() + dependencies.executionBudgetMs };
      try {
        let input = parseSimulationInput({
          rollId: dependencies.recipeSource.createRollId(),
          seed: dependencies.recipeSource.createRollSeed(),
          rolledSlots,
          pourStyle: dependencies.recipeSource.createPourStyle(),
        });
        for (let attempt = 0; attempt < MAX_ROLL_CANDIDATE_ATTEMPTS; attempt += 1) {
          if (monotonicNow() >= budget.deadlineMs) return { ok: false, reason: 'unavailable' };
          const result = await dependencies.simulation.execute(input, budget);
          if (monotonicNow() >= budget.deadlineMs) return { ok: false, reason: 'unavailable' };
          const mismatch = authoritativeResultMismatch(input, result);
          if (mismatch !== null) {
            reportUnexpected(
              dependencies.reportUnexpected,
              new Error('Invalid authoritative roll result'),
              'roll.result',
            );
            logger.error('roll.result.rejected', { reason: mismatch });
            return { ok: false, reason: 'unavailable' };
          }
          if (result.status === 'rejected') {
            if (attempt + 1 >= MAX_ROLL_CANDIDATE_ATTEMPTS) {
              return { ok: false, reason: 'unavailable' };
            }
            input = parseSimulationInput({
              ...input,
              seed: dependencies.recipeSource.createRollSeed(),
            });
            continue;
          }
          const artifact = parseResolvedRollArtifact({
            type: RESOLVED_ROLL_TYPE.RESOLVED,
            replay: {
              mode: RESOLVED_ROLL_TYPE.REPLAY_MODE,
              rollId: input.rollId,
              seed: input.seed,
              pourStyle: input.pourStyle,
              rolledSlots: input.rolledSlots,
              contract: dependencies.contract,
            },
            outcome: { authoritativeValuesBySlot: result.outcome.authoritativeValuesBySlot },
          });
          return {
            ok: true,
            artifact,
          };
        }
        return { ok: false, reason: 'unavailable' };
      } catch (error) {
        if (!(error instanceof RollSimulationExecutorError)) {
          reportUnexpected(dependencies.reportUnexpected, error, 'roll.command');
          logger.error('roll.command.failed', {
            error: error instanceof Error ? error : null,
          });
        }
        return {
          ok: false,
          reason:
            error instanceof RollSimulationExecutorError &&
            error.code === ROLL_SIMULATION_EXECUTOR_ERROR_CODE.CAPACITY
              ? 'capacity'
              : 'unavailable',
        };
      }
    },
  };
}

function authoritativeResultMismatch(
  expectedInput: SimulationInput,
  result: RollCandidateEvaluation,
): 'request_mismatch' | 'invalid_candidate' | null {
  // Custom executors share this authority boundary with the validated native IPC path.
  if (!isRollCandidateEvaluation(result)) return 'invalid_candidate';
  const actualInput = result.status === 'accepted' ? result.outcome.input : result.input;
  return actualInput.rollId !== expectedInput.rollId ||
    actualInput.seed !== expectedInput.seed ||
    actualInput.pourStyle !== expectedInput.pourStyle ||
    actualInput.rolledSlots.length !== expectedInput.rolledSlots.length ||
    actualInput.rolledSlots.some((slot, index) => slot !== expectedInput.rolledSlots[index])
    ? 'request_mismatch'
    : null;
}
