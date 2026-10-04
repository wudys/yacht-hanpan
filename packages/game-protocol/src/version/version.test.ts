import { DICE_SIMULATION_CONTRACT } from '@repo/dice-simulation/contract';
import { describe, expect, test } from 'bun:test';

import { GameApiParseError, parseWith } from '../internal/parse';
import {
  assertExactCompatibility,
  createCompatibilityContract,
  GAME_PROTOCOL_VERSION,
  parseCompatibilityContract,
} from './index';
import { responseMetaSchema } from './validation';

const RELEASE_ID = '2026-08-12.1-a5905df';
const REQUEST_ID = '97353947-22b7-4de5-b2e5-a3110ef752a4';

describe('compatibility contract', () => {
  test('builds the exact protocol and simulation fingerprint', () => {
    expect(createCompatibilityContract(RELEASE_ID)).toEqual({
      releaseId: RELEASE_ID,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
      simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
      timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
    });
  });

  test('strictly parses the four fields', () => {
    const contract = createCompatibilityContract(RELEASE_ID);
    expect(parseCompatibilityContract(contract)).toEqual(contract);
    expect(() => parseCompatibilityContract({ ...contract, compatibility: true })).toThrow(
      GameApiParseError,
    );
    expect(() => parseCompatibilityContract({ ...contract, simulationVersion: '' })).toThrow(
      GameApiParseError,
    );
  });

  test('rejects any exact-version mismatch', () => {
    const expected = createCompatibilityContract(RELEASE_ID);
    expect(() => assertExactCompatibility(expected, expected)).not.toThrow();
    expect(() =>
      parseCompatibilityContract({ ...expected, gameProtocolVersion: 'game-protocol-v14' }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseCompatibilityContract({ ...expected, timelineSchemaVersion: 'dice-timeline-v3' }),
    ).toThrow(GameApiParseError);
    expect(() =>
      assertExactCompatibility({ ...expected, releaseId: 'stale-release' }, expected),
    ).toThrow(GameApiParseError);
  });

  test('response metadata contains only request and protocol IDs', () => {
    const meta = parseWith(responseMetaSchema, {
      requestId: REQUEST_ID,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    });
    expect(String(meta.requestId)).toBe(REQUEST_ID);
    expect(meta.gameProtocolVersion).toBe(GAME_PROTOCOL_VERSION);
    expect(() =>
      parseWith(responseMetaSchema, {
        requestId: REQUEST_ID,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
        actionId: REQUEST_ID,
      }),
    ).toThrow(GameApiParseError);
  });
});
