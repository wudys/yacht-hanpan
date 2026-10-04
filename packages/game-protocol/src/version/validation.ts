import { DICE_SIMULATION_CONTRACT } from '@repo/dice-simulation/contract';
import * as v from 'valibot';

import { GameApiParseError, parseWith } from '../internal/parse';
import { epochMillisecondsSchema, requestIdSchema } from '../internal/primitives';
import { type CompatibilityContract, GAME_PROTOCOL_VERSION } from './types';

const releaseIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128), v.regex(/^[\w.-]+$/u));

export const compatibilityContractSchema = v.strictObject({
  releaseId: releaseIdSchema,
  gameProtocolVersion: v.literal(GAME_PROTOCOL_VERSION),
  simulationVersion: v.literal(DICE_SIMULATION_CONTRACT.simulationVersion),
  timelineSchemaVersion: v.literal(DICE_SIMULATION_CONTRACT.timelineSchemaVersion),
});

export const responseMetaSchema = v.strictObject({
  serverTime: v.optional(epochMillisecondsSchema),
  requestId: requestIdSchema,
  gameProtocolVersion: v.literal(GAME_PROTOCOL_VERSION),
});

export const timedResponseMetaSchema = v.strictObject({
  ...responseMetaSchema.entries,
  serverTime: epochMillisecondsSchema,
});

export function createCompatibilityContract(releaseId: string): CompatibilityContract {
  return parseCompatibilityContract({
    releaseId,
    gameProtocolVersion: GAME_PROTOCOL_VERSION,
    simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
    timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
  });
}

export function parseCompatibilityContract(value: unknown): CompatibilityContract {
  return parseWith(compatibilityContractSchema, value);
}

export function assertExactCompatibility(
  actual: unknown,
  expected: CompatibilityContract,
): CompatibilityContract {
  const parsed = parseCompatibilityContract(actual);
  if (
    parsed.releaseId !== expected.releaseId ||
    parsed.gameProtocolVersion !== expected.gameProtocolVersion ||
    parsed.simulationVersion !== expected.simulationVersion ||
    parsed.timelineSchemaVersion !== expected.timelineSchemaVersion
  ) {
    throw new GameApiParseError();
  }
  return parsed;
}
