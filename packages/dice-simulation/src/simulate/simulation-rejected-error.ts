import type { RollCandidateRejection, RollCandidateRejectionReason } from '../contract';

/** Strict replay callers cannot present a candidate that authority would reject. */
export class SimulationRejectedError extends Error {
  public readonly reason: RollCandidateRejectionReason;
  public readonly simulationMs: number;

  public constructor(rejection: Pick<RollCandidateRejection, 'reason' | 'simulationMs'>) {
    super('Roll candidate did not reach an accepted physical result');
    this.name = 'SimulationRejectedError';
    this.reason = rejection.reason;
    this.simulationMs = rejection.simulationMs;
  }
}
