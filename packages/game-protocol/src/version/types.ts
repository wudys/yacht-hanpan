import type { DICE_SIMULATION_CONTRACT } from '@repo/dice-simulation/contract';

export const GAME_PROTOCOL_VERSION = 'game-protocol-v17' as const;

export interface CompatibilityContract {
  readonly releaseId: string;
  readonly gameProtocolVersion: typeof GAME_PROTOCOL_VERSION;
  readonly simulationVersion: typeof DICE_SIMULATION_CONTRACT.simulationVersion;
  readonly timelineSchemaVersion: typeof DICE_SIMULATION_CONTRACT.timelineSchemaVersion;
}
