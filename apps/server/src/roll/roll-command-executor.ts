import type { SimulationInput } from '@repo/dice-simulation/contract';
import type { ResolvedRollArtifact } from '@repo/game-protocol/socket';

export interface RollCommandExecutionInput {
  readonly rolledSlots: SimulationInput['rolledSlots'];
}

export interface SuccessfulRollCommandExecution {
  readonly ok: true;
  readonly artifact: ResolvedRollArtifact;
}

export interface FailedRollCommandExecution {
  readonly ok: false;
  readonly reason: 'capacity' | 'unavailable';
}

export type RollCommandExecution = SuccessfulRollCommandExecution | FailedRollCommandExecution;

export interface RollCommandExecutor {
  execute(input: RollCommandExecutionInput): Promise<RollCommandExecution>;
}
