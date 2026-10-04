import {
  createReplayDigest,
  parseSimulationInput,
  type PourStyle,
  type SimulationInput,
  type SimulationResult,
} from '@repo/dice-simulation/contract';
import { parseResolvedRollArtifact, RESOLVED_ROLL_TYPE } from '@repo/game-protocol/socket';
import type { CompatibilityContract } from '@repo/game-protocol/version';

import type {
  RollCommandExecution,
  RollCommandExecutionInput,
  RollCommandExecutor,
} from '@/roll/command-executor';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  type RollSimulationExecutor,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import type { Logger } from '@/runtime/logger';

export interface RollRecipeSource {
  readonly createRollId: () => string;
  readonly createRollSeed: () => string;
  readonly createPourStyle: () => PourStyle;
}

interface AuthoritativeRollCommandExecutorDependencies {
  readonly contract: CompatibilityContract;
  readonly logger: Pick<Logger, 'error'>;
  readonly reportUnexpected?: ErrorReporter;
  readonly recipeSource: RollRecipeSource;
  readonly simulation: RollSimulationExecutor;
}

export function createAuthoritativeRollCommandExecutor(
  dependencies: AuthoritativeRollCommandExecutorDependencies,
): RollCommandExecutor {
  return {
    async execute({ rolledSlots }: RollCommandExecutionInput): Promise<RollCommandExecution> {
      const input: SimulationInput = {
        rollId: dependencies.recipeSource.createRollId(),
        seed: dependencies.recipeSource.createRollSeed(),
        rolledSlots,
        pourStyle: dependencies.recipeSource.createPourStyle(),
      };

      try {
        const result = await dependencies.simulation.execute(input);
        const mismatch = await authoritativeResultMismatch(input, result);
        if (mismatch !== null) {
          reportUnexpected(
            dependencies.reportUnexpected,
            new Error('Invalid authoritative roll result'),
            'roll.result',
          );
          dependencies.logger.error('roll.result.rejected', { reason: mismatch });
          return { ok: false, reason: 'unavailable' };
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
          outcome: { authoritativeValuesBySlot: result.authoritativeValuesBySlot },
          replayDigest: result.replayDigest,
        });
        return {
          ok: true,
          artifact,
        };
      } catch (error) {
        if (!(error instanceof RollSimulationExecutorError)) {
          reportUnexpected(dependencies.reportUnexpected, error, 'roll.command');
          dependencies.logger.error('roll.command.failed', {
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

async function authoritativeResultMismatch(
  expectedInput: SimulationInput,
  result: SimulationResult,
): Promise<
  'request_mismatch' | 'timeline_mismatch' | 'outcome_mismatch' | 'digest_mismatch' | null
> {
  const actualInput = parseSimulationInput(result.input);
  if (JSON.stringify(actualInput) !== JSON.stringify(parseSimulationInput(expectedInput)))
    return 'request_mismatch';
  if (
    result.timeline.rollId !== actualInput.rollId ||
    result.timeline.seed !== actualInput.seed ||
    result.timeline.dice.length !== actualInput.rolledSlots.length
  ) {
    return 'timeline_mismatch';
  }
  const timelineFaces = result.timeline.dice.map(({ slot, value }) => ({ slot, value }));
  if (JSON.stringify(timelineFaces) !== JSON.stringify(result.authoritativeValuesBySlot))
    return 'outcome_mismatch';
  return (await createReplayDigest(actualInput, result.timeline)) === result.replayDigest
    ? null
    : 'digest_mismatch';
}
