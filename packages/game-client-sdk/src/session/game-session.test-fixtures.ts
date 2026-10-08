import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCreateRoomResponse } from '@repo/game-protocol/http';
import {
  GAME_COMMAND_TYPE,
  type GameCommand,
  parseResolvedRollArtifact,
} from '@repo/game-protocol/socket';
import {
  type GameSnapshot,
  parseGameSnapshot,
  parsePresenceSnapshot,
  parsePublicRoom,
  parseRoomView,
  type RoomView,
} from '@repo/game-protocol/state';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';

import type { RawGameSocket } from '../socket/game-socket';

export const ROOM_ID = '01890f47-e89b-7cc3-98c5-4c5da03f78ab';
export const SEAT_TOKEN = '550e8400-e29b-41d4-a716-446655440000';
export const TURN_ID = 'de305d54-75b4-431b-adb2-eb6b9e546018';
export const NEXT_TURN_ID = 'de305d54-75b4-431b-adb2-eb6b9e546019';
export const REQUEST_ID = '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0';
export const AUTHORITY = (() => {
  const response = parseCreateRoomResponse({
    ok: true,
    data: {
      authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN },
      view: {
        room: {
          status: 'waiting',
          roomId: ROOM_ID,
          roomCode: '123456',
          createdAt: 1,
          expiresAt: 301_000,
          seats: [
            {
              profile: { characterId: 'navy-bob', variant: false },
            },
          ],
        },
        game: null,
        presence: {
          roomId: ROOM_ID,
          presenceVersion: 0,
          seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
        },
      },
    },
    meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
  });
  if (!response.ok) throw new Error('expected authority fixture');
  return response.data.authority;
})();

export function game(stateVersion: number, rolled: boolean = false) {
  return parseGameSnapshot({
    stateVersion,
    match: {
      status: 'playing',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        turnId: TURN_ID,
        seatIndex: 0,
        startedAt: 1,
        deadlineAt: 60_001,
        rollCount: rolled ? 1 : 0,
        heldSlots: [],
        dice: rolled ? Array.from({ length: 5 }, () => ({ value: 4 })) : null,
      },
    },
  });
}

export function finishedGame(stateVersion: number) {
  return parseGameSnapshot({
    stateVersion,
    match: {
      status: 'finished',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      result: { reason: 'scoresCompleted', winnerSeatIndex: null },
    },
  });
}

export function presence(version: number) {
  return parsePresenceSnapshot({
    roomId: ROOM_ID,
    presenceVersion: version,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  });
}

export function room() {
  return parsePublicRoom({
    status: 'playing',
    roomId: ROOM_ID,
    roomCode: '123456',
    createdAt: 1,
    startedAt: 2,
    seats: [
      { profile: { characterId: 'navy-bob', variant: false } },
      { profile: { characterId: 'blonde-buns', variant: false } },
    ],
  });
}

function finishedRoom() {
  return parsePublicRoom({
    status: 'finished',
    roomId: ROOM_ID,
    roomCode: '123456',
    createdAt: 1,
    startedAt: 2,
    finishedAt: 3,
    seats: [
      { profile: { characterId: 'navy-bob', variant: false } },
      { profile: { characterId: 'blonde-buns', variant: false } },
    ],
  });
}

export function viewFromGame(snapshot: GameSnapshot, presenceVersion: number = 1) {
  return parseRoomView({
    room: snapshot.match.status === 'finished' ? finishedRoom() : room(),
    game: snapshot,
    presence: presence(presenceVersion),
  });
}

export function scoreView(stateVersion: number = 2, final: boolean = false) {
  const baseline = game(stateVersion);
  if (baseline.match.status !== 'playing') throw new Error('expected playing fixture');
  const players = [{ scorecard: { ones: 0 }, timeoutCount: 0 }, baseline.match.players[1]];
  return viewFromGame(
    parseGameSnapshot({
      ...baseline,
      match: final
        ? {
            status: 'finished',
            players,
            result: { reason: 'scoresCompleted', winnerSeatIndex: null },
          }
        : {
            ...baseline.match,
            players,
            currentTurn: { ...baseline.match.currentTurn, turnId: NEXT_TURN_ID, seatIndex: 1 },
          },
    }),
  );
}

export function syncResponse(view: RoomView) {
  return {
    ok: true,
    data: view,
    meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
  };
}

export const ROLL = parseResolvedRollArtifact({
  type: 'roll:resolved',
  replay: {
    mode: 'seeded-physics',
    rollId: '8184fc0a-4e59-455d-a7c1-579a9ee96403',
    seed: 'server-seed',
    pourStyle: 'classic',
    rolledSlots: [0],
    contract: createCompatibilityContract('release-1'),
  },
  outcome: { authoritativeValuesBySlot: [{ slot: 0, value: 4 }] },
});

export class FakeSocket implements RawGameSocket {
  public readonly listeners: {
    connected: Set<() => void>;
    connectionError: Set<(value: unknown) => void>;
    disconnected: Set<() => void>;
    replaced: Set<() => void>;
    roomUpdate: Set<(value: unknown) => void>;
  } = {
    connected: new Set<() => void>(),
    connectionError: new Set<(value: unknown) => void>(),
    disconnected: new Set<() => void>(),
    replaced: new Set<() => void>(),
    roomUpdate: new Set<(value: unknown) => void>(),
  };
  public syncCount: number = 0;
  public disposed: boolean = false;
  public syncVersion: number = 1;
  public syncResponder: ((acknowledge: (value: unknown) => void) => void) | null = null;

  public connect = async (): Promise<void> => {
    for (const listener of this.listeners.connected) listener();
  };
  public disconnect = (): void => {
    for (const listener of this.listeners.disconnected) listener();
  };
  public dispose = (): void => {
    this.disposed = true;
    Object.values(this.listeners).forEach((listeners) => listeners.clear());
  };
  public emitCommand = (command: GameCommand, acknowledge: (value: unknown) => void): void => {
    acknowledge({
      ok: true,
      data: {
        receipt: {
          stateVersion: this.syncVersion + 1,
          ...(command.type === GAME_COMMAND_TYPE.ROLL_DICE ? { roll: ROLL } : {}),
        },
        view: viewFromGame(
          game(this.syncVersion + 1, command.type === GAME_COMMAND_TYPE.ROLL_DICE),
        ),
      },
      meta: {
        requestId: REQUEST_ID,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
        actionId: command.actionId,
      },
    });
  };
  public emitSync = (acknowledge: (value: unknown) => void): void => {
    this.syncCount += 1;
    if (this.syncResponder !== null) {
      this.syncResponder(acknowledge);
      return;
    }
    acknowledge({
      ok: true,
      data: { room: room(), game: game(this.syncVersion), presence: presence(this.syncVersion) },
      meta: { requestId: REQUEST_ID, serverTime: 1000, gameProtocolVersion: GAME_PROTOCOL_VERSION },
    });
  };
  public onConnected = (listener: () => void): (() => void) => this.add('connected', listener);
  public onConnectionError = (listener: (value: unknown) => void): (() => void) =>
    this.add('connectionError', listener);
  public onDisconnected = (listener: () => void): (() => void) =>
    this.add('disconnected', listener);
  public onReplaced = (listener: () => void): (() => void) => this.add('replaced', listener);
  public onRoomUpdate = (listener: (value: unknown) => void): (() => void) =>
    this.add('roomUpdate', listener);

  private add<Key extends keyof FakeSocket['listeners']>(
    key: Key,
    listener: Parameters<FakeSocket['listeners'][Key]['add']>[0],
  ): () => void {
    const listeners = this.listeners[key] as Set<typeof listener>;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
}

export class ReceiverSocket implements RawGameSocket {
  readonly #transport: FakeSocket = new FakeSocket();
  #syncs: number = 0;
  #commands: number = 0;

  public readonly connect: RawGameSocket['connect'] = this.#transport.connect;
  public readonly disconnect: RawGameSocket['disconnect'] = this.#transport.disconnect;
  public readonly dispose: RawGameSocket['dispose'] = this.#transport.dispose;
  public readonly onConnected: RawGameSocket['onConnected'] = this.#transport.onConnected;
  public readonly onConnectionError: RawGameSocket['onConnectionError'] =
    this.#transport.onConnectionError;
  public readonly onDisconnected: RawGameSocket['onDisconnected'] = this.#transport.onDisconnected;
  public readonly onReplaced: RawGameSocket['onReplaced'] = this.#transport.onReplaced;
  public readonly onRoomUpdate: RawGameSocket['onRoomUpdate'] = this.#transport.onRoomUpdate;

  public get syncCount(): number {
    return this.#syncs;
  }

  public get commandCount(): number {
    return this.#commands;
  }

  public emitSync(acknowledge: (value: unknown) => void): void {
    this.#syncs += 1;
    acknowledge(syncResponse(viewFromGame(game(1))));
  }

  public emitCommand(command: GameCommand, acknowledge: (value: unknown) => void): void {
    this.#commands += 1;
    acknowledge({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.NOT_YOUR_TURN, params: {} },
      meta: {
        requestId: REQUEST_ID,
        actionId: command.actionId,
        gameProtocolVersion: GAME_PROTOCOL_VERSION,
      },
    });
  }
}

export const RESPONSE = parseCreateRoomResponse({
  ok: true,
  data: {
    authority: {
      roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
      seatIndex: 0,
      seatToken: '550e8400-e29b-41d4-a716-446655440000',
    },
    view: {
      room: {
        status: 'waiting',
        roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
        roomCode: '123456',
        createdAt: 1,
        expiresAt: 301_000,
        seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
      },
      game: null,
      presence: {
        roomId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
        presenceVersion: 0,
        seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
      },
    },
  },
  meta: {
    requestId: '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0',
    serverTime: 1000,
    gameProtocolVersion: GAME_PROTOCOL_VERSION,
  },
});
if (!RESPONSE.ok) throw new Error('Expected waiting room fixture');
export const { authority, view } = RESPONSE.data;

export class ConnectionSocket implements RawGameSocket {
  public readonly listeners: {
    connected: Set<() => void>;
    disconnected: Set<() => void>;
    replaced: Set<() => void>;
    connectionError: Set<(value: unknown) => void>;
  } = {
    connected: new Set<() => void>(),
    disconnected: new Set<() => void>(),
    replaced: new Set<() => void>(),
    connectionError: new Set<(value: unknown) => void>(),
  };
  public connectCount: number = 0;
  public syncCount: number = 0;
  public disposed: boolean = false;
  public connected: boolean = false;

  public connect = async (): Promise<void> => {
    this.connectCount += 1;
    this.connected = true;
    for (const listener of this.listeners.connected) listener();
  };
  public disconnect = (): void => {
    if (!this.connected) return;
    this.connected = false;
    for (const listener of this.listeners.disconnected) listener();
  };
  public dispose = (): void => {
    this.disposed = true;
    this.connected = false;
    Object.values(this.listeners).forEach((listeners) => listeners.clear());
  };
  public emitSync: RawGameSocket['emitSync'] = (acknowledge) => {
    this.syncCount += 1;
    acknowledge({ ok: true, data: view, meta: RESPONSE.meta });
  };
  public emitCommand: RawGameSocket['emitCommand'] = () => {};
  public onConnectionError: RawGameSocket['onConnectionError'] = (listener) => {
    this.listeners.connectionError.add(listener);
    return () => this.listeners.connectionError.delete(listener);
  };
  public onRoomUpdate: RawGameSocket['onRoomUpdate'] = () => () => {};
  public onConnected: RawGameSocket['onConnected'] = (listener) => this.add('connected', listener);
  public onDisconnected: RawGameSocket['onDisconnected'] = (listener) =>
    this.add('disconnected', listener);
  public onReplaced: RawGameSocket['onReplaced'] = (listener) => this.add('replaced', listener);

  private add(key: 'connected' | 'disconnected' | 'replaced', listener: () => void): () => void {
    this.listeners[key].add(listener);
    return () => this.listeners[key].delete(listener);
  }
}
