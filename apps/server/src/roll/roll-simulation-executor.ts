import type { SimulationInput, SimulationOutcome } from '@repo/dice-simulation/contract';

export const ROLL_SIMULATION_EXECUTOR_ERROR_CODE = {
  CAPACITY: 'CAPACITY',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export type RollSimulationExecutorErrorCode =
  (typeof ROLL_SIMULATION_EXECUTOR_ERROR_CODE)[keyof typeof ROLL_SIMULATION_EXECUTOR_ERROR_CODE];

export class RollSimulationExecutorError extends Error {
  public readonly code: RollSimulationExecutorErrorCode;

  public constructor(code: RollSimulationExecutorErrorCode) {
    super('Roll simulation unavailable');
    this.name = 'RollSimulationExecutorError';
    this.code = code;
  }
}

export interface RollSimulationExecutor {
  execute(input: SimulationInput): Promise<SimulationOutcome>;
}
