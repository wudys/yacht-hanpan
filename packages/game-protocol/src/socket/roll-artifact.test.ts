import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { describe, expect, test } from 'bun:test';

import { GameApiParseError } from '../internal/parse';
import { GAME_PROTOCOL_VERSION } from '../version';
import { parseCommandAck, parseCommittedRoomUpdate, parseResolvedRollArtifact } from './index';

const RELEASE_ID = '2026-08-12.1-a5905df';
const ROLL_ID = '8184fc0a-4e59-455d-a7c1-579a9ee96403';
const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
const replay = {
  mode: 'seeded-physics',
  rollId: ROLL_ID,
  seed: 'server-csprng-seed',
  pourStyle: POUR_STYLE.CLASSIC,
  rolledSlots: [0, 2, 4],
  contract: {
    releaseId: RELEASE_ID,
    gameProtocolVersion: GAME_PROTOCOL_VERSION,
    simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
    timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
  },
} as const;
const outcome = {
  authoritativeValuesBySlot: [
    { slot: 0, value: 1 },
    { slot: 2, value: 4 },
    { slot: 4, value: 6 },
  ],
} as const;
const replayDigest = `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:${'a'.repeat(64)}`;

const view = {
  room: {
    status: 'playing',
    roomId: ROOM_ID,
    roomCode: '001204',
    createdAt: 1000,
    startedAt: 1000,
    seats: [
      { profile: { characterId: 'navy-bob', variant: false } },
      { profile: { characterId: 'blonde-buns', variant: false } },
    ],
  },
  game: {
    stateVersion: 1,
    match: {
      status: 'playing',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        turnId: ROLL_ID,
        seatIndex: 0,
        startedAt: 1000,
        deadlineAt: 61000,
        rollCount: 1,
        heldSlots: [],
        dice: [{ value: 1 }, { value: 2 }, { value: 4 }, { value: 5 }, { value: 6 }],
      },
    },
  },
  presence: {
    roomId: ROOM_ID,
    presenceVersion: 1,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  },
} as const;
const artifactParsers = [
  { name: 'standalone artifact', parse: parseResolvedRollArtifact },
  {
    name: 'command acknowledgement',
    parse: (roll: unknown) =>
      parseCommandAck({
        ok: true,
        data: { receipt: { stateVersion: 1, roll }, view },
        meta: { requestId: ROLL_ID, actionId: ROLL_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION },
      }),
  },
  {
    name: 'committed update',
    parse: (roll: unknown) => parseCommittedRoomUpdate({ type: 'roll:committed', roll, view }),
  },
];

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('resolved roll artifact', () => {
  describe.each(artifactParsers)('$name validates artifact invariants', ({ parse }) => {
    test('accepts a canonical artifact', () => {
      expect(() => parse({ type: 'roll:resolved', replay, outcome, replayDigest })).not.toThrow();
    });

    test.each([
      { replay: { ...replay, rolledSlots: [0, 0, 4] } },
      { replay: { ...replay, rolledSlots: [2, 0, 4] } },
      { outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 1 }] } },
      {
        outcome: {
          authoritativeValuesBySlot: [
            { slot: 0, value: 1 },
            { slot: 3, value: 4 },
            { slot: 4, value: 6 },
          ],
        },
      },
      {
        outcome: {
          authoritativeValuesBySlot: [
            { slot: 0, value: 1 },
            { slot: 0, value: 4 },
            { slot: 4, value: 6 },
          ],
        },
      },
      {
        outcome: {
          authoritativeValuesBySlot: [
            { slot: 2, value: 4 },
            { slot: 0, value: 1 },
            { slot: 4, value: 6 },
          ],
        },
      },
      { replayDigest: `${DICE_SIMULATION_CONTRACT.replayDigestVersion}:not-sha256` },
      { replayDigest: `sha256-q4-v1:${'a'.repeat(64)}` },
      { replayDigest: `unsupported:${'a'.repeat(64)}` },
      { replayDigest: `${replayDigest}:extra` },
    ])('rejects invalid artifact %j', (override) => {
      expect(() =>
        parse({ type: 'roll:resolved', replay, outcome, replayDigest, ...override }),
      ).toThrow(GameApiParseError);
    });
  });

  test.each(['classic', 'burst', 'oblique'])('accepts selected %s recipe', (pourStyle) => {
    expect(
      parseResolvedRollArtifact({
        type: 'roll:resolved',
        replay: { ...replay, pourStyle },
        outcome,
        replayDigest,
      }).replay.pourStyle,
    ).toBe(pourStyle);
  });

  test.each(['toss', 'ricochet'])(
    'rejects retired %s recipe instead of silently remapping it',
    (pourStyle) => {
      expect(() =>
        parseResolvedRollArtifact({
          type: 'roll:resolved',
          replay: { ...replay, pourStyle },
          outcome,
          replayDigest,
        }),
      ).toThrow(GameApiParseError);
    },
  );
  test('accepts only compact recipe, outcome, and digest', () => {
    const artifact = { type: 'roll:resolved', replay, outcome, replayDigest };
    expect(plain(parseResolvedRollArtifact(artifact))).toEqual(artifact);
  });

  test.each([
    { type: 'roll:resolved', replay, outcome, replayDigest, timeline: [] },
    { type: 'roll:resolved', replay, outcome, replayDigest, frames: [] },
    { type: 'roll:resolved', replay: { ...replay, seed: ' padded ' }, outcome, replayDigest },
    {
      type: 'roll:resolved',
      replay: { ...replay, targetValues: [1, 4, 6] },
      outcome,
      replayDigest,
    },
    {
      type: 'roll:resolved',
      replay: { ...replay, authoritativeValuesBySlot: outcome.authoritativeValuesBySlot },
      outcome,
      replayDigest,
    },
    {
      type: 'roll:resolved',
      replay,
      outcome: { ...outcome, targetFaces: [1, 4, 6] },
      replayDigest,
    },
  ])('rejects timeline and target/output inputs', (value) => {
    expect(() => parseResolvedRollArtifact(value)).toThrow(GameApiParseError);
  });

  test('authoritative outcome mutation leaves replay unchanged and fails slot parity', () => {
    const changedOutcome = {
      authoritativeValuesBySlot: [
        { slot: 0, value: 6 },
        { slot: 3, value: 4 },
        { slot: 4, value: 1 },
      ],
    };
    expect(() =>
      parseResolvedRollArtifact({
        type: 'roll:resolved',
        replay,
        outcome: changedOutcome,
        replayDigest,
      }),
    ).toThrow(GameApiParseError);
    expect(replay.rolledSlots).toEqual([0, 2, 4]);
  });
});
