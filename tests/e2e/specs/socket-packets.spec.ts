import { expect, test } from '@playwright/test';
import { SOCKET_EVENT } from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';

import {
  createSocketPacketObserver,
  decodeSocketPacket,
  readRoomStatePacket,
} from '../helpers/socket-packets';

const roomId = '01890f47-e89b-7cc3-98c5-4c5da03f78ab';
const actionId = '550e8400-e29b-41d4-a716-446655440000';
const turnId = 'de305d54-75b4-431b-adb2-eb6b9e546018';
const meta = {
  requestId: '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0',
  gameProtocolVersion: GAME_PROTOCOL_VERSION,
};
const view = {
  room: {
    status: 'waiting',
    roomId,
    roomCode: '001204',
    createdAt: 1_000,
    expiresAt: 301_000,
    seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
  },
  game: null,
  presence: { roomId, presenceVersion: 1, seats: [{ status: 'connected' }] },
};
const syncSuccess = { ok: true, data: view, meta: { ...meta, serverTime: 1_000 } };
const command = { type: 'rollDice', actionId, turnId };
const commandFailure = {
  ok: false,
  error: { code: 'INTERNAL_ERROR', params: {} },
  meta: { ...meta, actionId },
};

test('request IDs distinguish interleaved command and sync ACKs, including failed sync', () => {
  const observer = createSocketPacketObserver();
  expect(
    observer.observeClient(`427${JSON.stringify([SOCKET_EVENT.GAME_COMMAND, command])}`),
  ).toMatchObject({ kind: 'command', ackId: '7', command });
  expect(observer.observeClient('428["game:sync"]')).toEqual({ kind: 'sync', ackId: '8' });
  expect(observer.observeServer(`437${JSON.stringify([commandFailure])}`)).toMatchObject({
    kind: 'command',
    ackId: '7',
    ack: commandFailure,
  });
  expect(observer.observeServer(`438${JSON.stringify([syncSuccess])}`)).toMatchObject({
    kind: 'sync',
    ackId: '8',
    ack: syncSuccess,
  });
  observer.observeClient('429["game:sync"]');
  const failure = { ok: false, error: { code: 'ROOM_NOT_FOUND', params: {} }, meta };
  expect(observer.observeServer(`439${JSON.stringify([failure])}`)).toMatchObject({
    kind: 'sync',
    ackId: '9',
    ack: failure,
  });
});

test('unknown and duplicate ACKs do not become new successes, and connections are independent', () => {
  const first = createSocketPacketObserver();
  const next = createSocketPacketObserver();
  first.observeClient('420["game:sync"]');
  expect(next.observeServer(`430${JSON.stringify([syncSuccess])}`)).toBeNull();
  expect(first.observeServer('431[malformed unknown ACK')).toBeNull();
  expect(first.observeServer(`430${JSON.stringify([syncSuccess])}`)).not.toBeNull();
  expect(first.observeServer('430[malformed duplicate ACK')).toBeNull();
  first.observeClient('421["game:sync"]');
  first.dispose();
  expect(first.observeServer(`431${JSON.stringify([syncSuccess])}`)).toBeNull();
  expect(first.observeClient('422["game:sync"]')).toBeNull();
  next.observeClient('420["game:sync"]');
  expect(next.observeServer(`430${JSON.stringify([syncSuccess])}`)).not.toBeNull();
});

test('a successful command ACK keeps its receipt and current view distinct from sync data', () => {
  const observer = createSocketPacketObserver();
  const playingView = {
    room: {
      status: 'playing',
      roomId,
      roomCode: view.room.roomCode,
      createdAt: view.room.createdAt,
      startedAt: 2_000,
      seats: [view.room.seats[0], { profile: { characterId: 'blonde-buns', variant: false } }],
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
          turnId,
          seatIndex: 0,
          startedAt: 2_000,
          deadlineAt: 62_000,
          rollCount: 1,
          heldSlots: [],
          dice: [{ value: 6 }, { value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }],
        },
      },
    },
    presence: { ...view.presence, seats: [{ status: 'connected' }, { status: 'connected' }] },
  };
  const success = {
    ok: true,
    data: { receipt: { stateVersion: 4 }, view: playingView },
    meta: { ...meta, actionId },
  };
  observer.observeClient(`420${JSON.stringify([SOCKET_EVENT.GAME_COMMAND, command])}`);
  observer.observeClient('421["game:sync"]');
  expect(observer.observeServer(`430${JSON.stringify([success])}`)).toMatchObject({
    kind: 'command',
    ackId: '0',
    command,
    ack: success,
  });
  expect(observer.observeServer(`431${JSON.stringify([syncSuccess])}`)).toMatchObject({
    kind: 'sync',
    ackId: '1',
    ack: syncSuccess,
  });
});

test('idless room updates are validated without treating other event payloads as authority', () => {
  const update = { type: 'state:committed', view };
  expect(readRoomStatePacket(`42${JSON.stringify([SOCKET_EVENT.ROOM_STATE, update])}`)).toEqual(
    update,
  );
  expect(decodeSocketPacket('42["session:replaced"]')).toEqual({
    kind: 'event',
    ackId: null,
    name: SOCKET_EVENT.SESSION_REPLACED,
    args: [],
  });
  expect(readRoomStatePacket('42["unrelated",{"invalid":true}]')).toBeNull();
  expect(readRoomStatePacket('430[malformed unrelated ACK')).toBeNull();
  expect(createSocketPacketObserver().observeClient('42["unrelated",null]')).toBeNull();
  expect(createSocketPacketObserver().observeClient('430[malformed unrelated ACK')).toBeNull();
  expect(() => readRoomStatePacket('42["room:state",null]')).toThrow();
});

test('malformed related frames fail without exposing their raw values', () => {
  const observer = createSocketPacketObserver();
  observer.observeClient('420["game:sync"]');
  expect(() => observer.observeServer('430["private-fixture-value"')).toThrow(
    /^Invalid default Socket\.IO packet$/u,
  );
  observer.observeClient('421["game:sync"]');
  expect(() => observer.observeServer('431[null]')).toThrow();
  expect(() => observer.observeClient('422["game:command",null]')).toThrow();
  expect(() => observer.observeClient('423["game:sync",null]')).toThrow(
    'Invalid game sync request',
  );
  expect(() => readRoomStatePacket('42["room:state",')).toThrow('Invalid default Socket.IO packet');
});

test('ACK parsing retains INVALID_REQUEST and ACTION_RESULT_EXPIRED failure contracts', () => {
  for (const [index, failure] of [
    {
      ok: false,
      error: { code: 'INVALID_REQUEST', params: {} },
      meta: { ...meta, actionId: null },
    },
    {
      ok: false,
      error: { code: 'ACTION_RESULT_EXPIRED', params: {} },
      recovery: view,
      meta: { ...meta, actionId },
    },
  ].entries()) {
    const observer = createSocketPacketObserver();
    observer.observeClient(`42${index}${JSON.stringify([SOCKET_EVENT.GAME_COMMAND, command])}`);
    expect(observer.observeServer(`43${index}${JSON.stringify([failure])}`)).toMatchObject({
      kind: 'command',
      ack: failure,
    });
  }
  const observer = createSocketPacketObserver();
  observer.observeClient(`420${JSON.stringify([SOCKET_EVENT.GAME_COMMAND, command])}`);
  expect(() =>
    observer.observeServer(
      `430${JSON.stringify([{ ...commandFailure, meta: { ...meta, actionId: null } }])}`,
    ),
  ).toThrow();
});

test('binary, namespace and Engine.IO control frames pass through without interpretation', () => {
  for (const frame of [
    Buffer.from([4, 2]),
    '0{"sid":"fixture"}',
    '2',
    '3',
    '40{}',
    '41',
    '451-["room:state",{}]',
    '42/game,0["game:sync"]',
    '43/game,0[{}]',
  ]) {
    expect(decodeSocketPacket(frame)).toBeNull();
    expect(readRoomStatePacket(frame)).toBeNull();
  }
});
