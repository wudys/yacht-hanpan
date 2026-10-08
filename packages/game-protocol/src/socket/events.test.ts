import { DICE_SIMULATION_CONTRACT, POUR_STYLE } from '@repo/dice-simulation/contract';
import { parseGameSnapshot } from '@repo/game-protocol/state';
import { describe, expect, test } from 'bun:test';

import { GameApiParseError } from '../internal/parse';
import { GAME_PROTOCOL_VERSION } from '../version';
import { parseCommittedRoomUpdate, ROOM_UPDATE_TYPE } from './index';

const TURN_ID = 'c847f81e-8ee0-43ef-b09a-f8ef14612246';
const ROOM_ID = '018f47f2-c2d8-7f4a-8bf4-3f559c39843e';

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

describe('authoritative events', () => {
  test('parses an ordered state update whose snapshot carries its version', () => {
    const update = {
      type: ROOM_UPDATE_TYPE.STATE_COMMITTED,
      view,
    };
    expect(parseCommittedRoomUpdate(update).type).toBe(ROOM_UPDATE_TYPE.STATE_COMMITTED);
  });

  test('parses a live roll update with one compact resolved artifact', () => {
    expect(JSON.parse(JSON.stringify(parseCommittedRoomUpdate(rollUpdate)))).toEqual(rollUpdate);
  });

  test.each([
    { name: 'an unrolled turn', snapshot },
    {
      name: 'a finished match',
      snapshot: {
        ...snapshot,
        match: {
          status: 'finished',
          players: snapshot.match.players,
          result: { reason: 'scoresCompleted', winnerSeatIndex: null },
        },
      },
    },
    {
      name: 'a later rolled slot with a different face',
      snapshot: {
        ...rollUpdate.view.game,
        match: {
          ...rollUpdate.view.game.match,
          currentTurn: {
            ...rollUpdate.view.game.match.currentTurn,
            dice: [{ value: 6 }, { value: 2 }, { value: 4 }, { value: 5 }, { value: 1 }],
          },
        },
      },
    },
  ])('rejects a roll update paired with $name', ({ snapshot: inconsistentSnapshot }) => {
    const parsedSnapshot = parseGameSnapshot(inconsistentSnapshot);
    const room =
      parsedSnapshot.match.status === 'finished'
        ? { ...playingRoom, status: 'finished', finishedAt: 3_000 }
        : playingRoom;
    expect(() =>
      parseCommittedRoomUpdate({ ...rollUpdate, view: { ...view, room, game: parsedSnapshot } }),
    ).toThrow(GameApiParseError);
  });

  test.each([
    {
      type: ROOM_UPDATE_TYPE.STATE_COMMITTED,
      view,
      eventId: '7d4228f3-16dc-4db4-ae6b-ad8d85ab1ee8',
    },
    {
      type: ROOM_UPDATE_TYPE.STATE_COMMITTED,
      stateVersion: 4,
      view,
    },
    {
      type: ROOM_UPDATE_TYPE.STATE_COMMITTED,
      view,
      timeline: [],
    },
  ])('rejects redundant identity and historical animation fields', (update) => {
    expect(() => parseCommittedRoomUpdate(update)).toThrow(GameApiParseError);
  });

  test('publishes a whole waiting view through the same live event', () => {
    const waitingView = {
      room: {
        status: 'waiting',
        roomId: ROOM_ID,
        roomCode: '001204',
        createdAt: 1_000,
        expiresAt: 301_000,
        seats: [playingRoom.seats[0]],
      },
      game: null,
      presence: { ...presence, presenceVersion: 0, seats: [presence.seats[0]] },
    } as const;
    const update = { type: ROOM_UPDATE_TYPE.STATE_COMMITTED, view: waitingView };
    expect<unknown>(parseCommittedRoomUpdate(update)).toEqual(update);
    expect(() =>
      parseCommittedRoomUpdate({
        type: ROOM_UPDATE_TYPE.ROLL_COMMITTED,
        view: waitingView,
        roll: rollUpdate.roll,
      }),
    ).toThrow(GameApiParseError);
  });

  test('rejects legacy partial live updates', () => {
    expect(() =>
      parseCommittedRoomUpdate({ type: ROOM_UPDATE_TYPE.STATE_COMMITTED, snapshot }),
    ).toThrow(GameApiParseError);
  });
});
