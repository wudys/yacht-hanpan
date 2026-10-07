import type { RollCandidateEvaluation, SimulationInput } from '@repo/dice-simulation/contract';

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

export interface RollExecutionBudget {
  // Absolute deadline for the whole command, using the authority's monotonic clock origin.
  readonly deadlineMs: number;
}

export interface RollSimulationExecutor {
  // Adapters share that clock origin, settle every call, and reclaim queued/native work
  // within the deadline. Expected capacity or execution failures reject with
  // RollSimulationExecutorError (CAPACITY or UNAVAILABLE); unexpected faults retain their cause.
  execute(input: SimulationInput, budget: RollExecutionBudget): Promise<RollCandidateEvaluation>;
}
