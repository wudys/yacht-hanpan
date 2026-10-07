import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { describe, expect, test } from 'bun:test';

import { PUBLIC_ERROR_CODE } from '../errors';
import { GameApiParseError } from '../internal/parse';
import { GAME_PROTOCOL_VERSION } from '../version';
import { parseCommandAck, parseSyncAck } from './acks';
import { ROOM_UPDATE_TYPE } from './index';

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('socket acknowledgements', () => {
  const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
  const SEAT_TOKEN = 'd0379b77-4d7b-4611-83fc-d5dcde34bdc2';
  const ACTION_ID = 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d';
  const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';
  const REQUEST_ID = '97353947-22b7-4de5-b2e5-a3110ef752a4';
  const contract = {
    releaseId: '2026-08-12.1-a5905df',
    gameProtocolVersion: GAME_PROTOCOL_VERSION,
    simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
    timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
  } as const;
  const meta = { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION } as const;
  const roll = {
    type: 'roll:resolved',
    replay: {
      mode: 'seeded-physics',
      rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
      seed: 'server-csprng-seed',
      pourStyle: POUR_STYLE.CLASSIC,
      rolledSlots: [0],
      contract,
    },
    outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 6 }] },
  } as const;

  const view = {
    room: {
      status: 'playing',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1_000,
      startedAt: 2_000,
      seats: [
        { profile: { characterId: 'navy-bob', variant: false } },
        { profile: { characterId: 'blonde-buns', variant: false } },
      ],
    },
    game: {
      stateVersion: 5,
      match: {
        status: 'playing',
        players: [
          { scorecard: {}, timeoutCount: 0 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        currentTurn: {
          turnId: TURN_ID,
          seatIndex: 0,
          startedAt: 2_000,
          deadlineAt: 62_000,
          rollCount: 1,
          heldSlots: [],
          dice: [{ value: 6 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
        },
      },
    },
    presence: {
      roomId: ROOM_ID,
      presenceVersion: 2,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    },
  } as const;

  test('parses command success with distinct request/action/state identifiers', () => {
    const ack = {
      ok: true,
      data: { receipt: { stateVersion: 4 }, view },
      meta: { ...meta, actionId: ACTION_ID },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
  });

  test('parses a strict roll success carrying the authoritative compact artifact', () => {
    const ack = {
      ok: true,
      data: { receipt: { stateVersion: 5, roll }, view },
      meta: { ...meta, actionId: ACTION_ID },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
  });

  test.each([
    { stateVersion: 5, roll: { ...roll, timeline: [] } },
    { stateVersion: 5, roll: { ...roll, targetFaces: [6] } },
    { stateVersion: 5, roll, extra: true },
  ])('rejects an expanded or contradictory roll success payload', (data) => {
    expect(() =>
      parseCommandAck({
        ok: true,
        data: { receipt: data, view },
        meta: { ...meta, actionId: ACTION_ID },
      }),
    ).toThrow(GameApiParseError);
  });

  test('shares public error semantics without private messages', () => {
    const ack = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
      meta: { ...meta, actionId: ACTION_ID },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
    expect(JSON.stringify(parseCommandAck(ack))).not.toMatch(/message|stack|token/iu);
  });

  test.each([null, ACTION_ID])('represents malformed commands with actionId %s', (actionId) => {
    const ack = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST, params: {} },
      meta: { ...meta, actionId },
    };
    expect(plain(parseCommandAck(ack))).toEqual(ack);
    expect(() =>
      parseCommandAck({
        ...ack,
        error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
        meta: { ...meta, actionId: null },
      }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    {
      ok: true,
      data: { receipt: { stateVersion: 4 }, view },
      error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
      meta: { ...meta, actionId: ACTION_ID },
    },
    {
      ok: false,
      error: { code: 'PRIVATE_WORKER_ERROR', params: {} },
      meta: { ...meta, actionId: ACTION_ID },
    },
  ])('rejects contradictory or unknown acknowledgements', (ack) => {
    expect(() => parseCommandAck(ack)).toThrow(GameApiParseError);
  });

  test('sync success carries strict public room metadata without credentials', () => {
    const ack = {
      ok: true,
      data: {
        room: {
          status: 'playing',
          roomId: ROOM_ID,
          roomCode: '001204',
          createdAt: 1_000,
          startedAt: 2_000,
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
              turnId: TURN_ID,
              seatIndex: 0,
              startedAt: 2_000,
              deadlineAt: 62_000,
              rollCount: 0,
              heldSlots: [],
              dice: null,
            },
          },
        },
        presence: {
          roomId: ROOM_ID,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'connected' }],
        },
      },
      meta: { ...meta, serverTime: 2_000 },
    } as const;

    expect(plain(parseSyncAck(ack))).toEqual(ack);
    expect(JSON.stringify(parseSyncAck(ack))).not.toMatch(/seatToken|clientId|imageUrl/iu);
    expect(() =>
      parseSyncAck({
        ...ack,
        data: {
          ...ack.data,
          room: {
            ...ack.data.room,
            seats: [
              { profile: { characterId: 'navy-bob', variant: false }, seatToken: SEAT_TOKEN },
              ack.data.room.seats[1],
            ],
          },
        },
      }),
    ).toThrow(GameApiParseError);
  });

  test('rejects a full sync whose room, game, and presence are not one coherent snapshot', () => {
    const waiting = {
      ok: true,
      data: {
        room: {
          status: 'waiting',
          roomId: ROOM_ID,
          roomCode: '001204',
          createdAt: 1_000,
          expiresAt: 301_000,
          seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
        },
        game: null,
        presence: {
          roomId: ROOM_ID,
          presenceVersion: 1,
          seats: [{ status: 'connected' }],
        },
      },
      meta: { ...meta, serverTime: 2_000 },
    } as const;

    expect(() =>
      parseSyncAck({
        ...waiting,
        data: {
          ...waiting.data,
          presence: { ...waiting.data.presence, roomId: '018f47f2-c2d8-7f4a-8bf4-3f559c398444' },
        },
      }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseSyncAck({
        ...waiting,
        data: {
          ...waiting.data,
          game: {
            stateVersion: 1,
            match: {
              status: 'finished',
              players: [
                { scorecard: {}, timeoutCount: 0 },
                { scorecard: {}, timeoutCount: 0 },
              ],
              result: { reason: 'scoresCompleted', winnerSeatIndex: null },
            },
          },
        },
      }),
    ).toThrow(GameApiParseError);
  });

  test('sync failure uses the same envelope and no actionId', () => {
    const ack = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
      meta,
    };
    expect(plain(parseSyncAck(ack))).toEqual(ack);
    expect(() => parseSyncAck({ ...ack, meta: { ...meta, actionId: ACTION_ID } })).toThrow(
      GameApiParseError,
    );
  });
});

describe('acknowledgement room views and recovery', () => {
  const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';
  const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';
  const REQUEST_ID = '97353947-22b7-4de5-b2e5-a3110ef752a4';

  const snapshot = {
    stateVersion: 4,
    match: {
      status: 'playing',
      players: [
        {
          scorecard: {},
          timeoutCount: 0,
        },
        {
          scorecard: {},
          timeoutCount: 0,
        },
      ],
      currentTurn: {
        turnId: TURN_ID,
        seatIndex: 0,
        startedAt: 1_000,
        deadlineAt: 61_000,
        rollCount: 0,
        heldSlots: [],
        dice: null,
      },
    },
  } as const;
  const playingRoom = {
    status: 'playing',
    roomId: ROOM_ID,
    roomCode: '001204',
    createdAt: 1_000,
    startedAt: 2_000,
    seats: [
      { profile: { characterId: 'navy-bob', variant: false } },
      { profile: { characterId: 'blonde-buns', variant: false } },
    ],
  } as const;
  const presence = {
    roomId: ROOM_ID,
    presenceVersion: 2,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  } as const;
  const view = { room: playingRoom, game: snapshot, presence } as const;
  const rollUpdate = {
    type: ROOM_UPDATE_TYPE.ROLL_COMMITTED,
    view: {
      ...view,
      game: {
        ...snapshot,
        match: {
          ...snapshot.match,
          currentTurn: {
            ...snapshot.match.currentTurn,
            rollCount: 2,
            heldSlots: [1, 2, 3],
            dice: [{ value: 6 }, { value: 2 }, { value: 4 }, { value: 5 }, { value: 3 }],
          },
        },
      },
    },
    roll: {
      type: 'roll:resolved',
      replay: {
        mode: 'seeded-physics',
        rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
        seed: 'server-seed',
        pourStyle: POUR_STYLE.CLASSIC,
        rolledSlots: [0, 4],
        contract: {
          releaseId: '2026-08-12.1-a5905df',
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          simulationVersion: DICE_SIMULATION_CONTRACT.simulationVersion,
          timelineSchemaVersion: DICE_SIMULATION_CONTRACT.timelineSchemaVersion,
        },
      },
      outcome: {
        authoritativeValuesBySlot: [
          { slot: 0, value: 6 },
          { slot: 4, value: 3 },
        ],
      },
    },
  } as const;

  test('sync success parses payload game and independent presence versions', () => {
    const presence = {
      roomId: ROOM_ID,
      presenceVersion: 2,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    };
    const parsed = parseSyncAck({
      ok: true,
      data: { room: playingRoom, game: snapshot, presence },
      meta: { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION, serverTime: 1000 },
    });
    expect(parsed.ok).toBeTrue();
    if (!parsed.ok || parsed.data.game === null) throw new Error('expected playing sync');
    expect(Number(parsed.data.game.stateVersion)).toBe(4);
    expect(Number(parsed.data.presence.presenceVersion)).toBe(2);
  });

  test('sync success represents a waiting room with presence and no game', () => {
    const parsed = parseSyncAck({
      ok: true,
      data: {
        room: {
          status: 'waiting',
          roomId: ROOM_ID,
          roomCode: '001204',
          createdAt: 1_000,
          expiresAt: 301_000,
          seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
        },
        game: null,
        presence: {
          roomId: ROOM_ID,
          presenceVersion: 1,
          seats: [{ status: 'connected' }],
        },
      },
      meta: { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION, serverTime: 1000 },
    });

    expect(parsed).toMatchObject({ ok: true, data: { game: null } });
  });

  test('requires current snapshot recovery only for expired action results', () => {
    const presence = {
      roomId: ROOM_ID,
      presenceVersion: 2,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    } as const;
    const expired = {
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
      recovery: { room: playingRoom, game: snapshot, presence },
      meta: {
        requestId: REQUEST_ID,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
        actionId: 'a635fe2c-c4c8-4382-80d7-c35c5d5d455d',
      },
    } as const;

    expect(JSON.parse(JSON.stringify(parseCommandAck(expired)))).toEqual(expired);
    expect(() => parseCommandAck({ ...expired, recovery: undefined })).toThrow(GameApiParseError);
    expect(() =>
      parseCommandAck({ ...expired, meta: { ...expired.meta, actionId: null } }),
    ).toThrow(GameApiParseError);
    expect(() =>
      parseCommandAck({
        ...expired,
        error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
      }),
    ).toThrow(GameApiParseError);
  });

  test('keeps an original roll receipt when its accompanying view has moved on or finished', () => {
    const receipt = { stateVersion: 4, roll: rollUpdate.roll };
    const meta = {
      requestId: REQUEST_ID,
      actionId: REQUEST_ID,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    };
    const advanced = { ...view, game: { ...snapshot, stateVersion: 5 } };
    const finished = {
      ...view,
      room: { ...playingRoom, status: 'finished', finishedAt: 3_000 },
      game: {
        stateVersion: 6,
        match: {
          status: 'finished',
          players: snapshot.match.players,
          result: { reason: 'explicitForfeit', winnerSeatIndex: 1 },
        },
      },
    };
    for (const currentView of [advanced, finished]) {
      const ack = { ok: true, data: { receipt, view: currentView }, meta };
      expect<unknown>(parseCommandAck(ack)).toEqual(ack);
    }
  });

  test('rejects a receipt ahead of its view and a same-version roll with inconsistent dice', () => {
    const meta = {
      requestId: REQUEST_ID,
      actionId: REQUEST_ID,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    };
    const ack = {
      ok: true,
      data: { receipt: { stateVersion: 4, roll: rollUpdate.roll }, view: rollUpdate.view },
      meta,
    };
    expect<unknown>(parseCommandAck(ack)).toEqual(ack);
    expect(() =>
      parseCommandAck({
        ...ack,
        data: { ...ack.data, receipt: { ...ack.data.receipt, stateVersion: 5 } },
      }),
    ).toThrow(GameApiParseError);
    expect(() => parseCommandAck({ ...ack, data: { ...ack.data, view } })).toThrow(
      GameApiParseError,
    );
  });

  test('rejects receipt-only success envelopes', () => {
    expect(() =>
      parseCommandAck({
        ok: true,
        data: { stateVersion: 4, roll: rollUpdate.roll },
        meta: {
          requestId: REQUEST_ID,
          actionId: REQUEST_ID,
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      }),
    ).toThrow(GameApiParseError);
  });
});
