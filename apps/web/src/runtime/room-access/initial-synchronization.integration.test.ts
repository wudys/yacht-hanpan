import { createGameClient, type RawGameSocket } from '@repo/game-client-sdk';
import { CLIENT_ERROR_CODE } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { parseGameSnapshot } from '@repo/game-protocol/socket';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { expect, test, vi } from 'vitest';

import { createRoomAccess } from '@/runtime/room-access/room-access';
import { createStoredRoomReentry } from '@/runtime/room-access/stored-room-reentry';
import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import { createSessionCredentialStore } from '@/runtime/session/session-credential-store';
import { createSessionRecovery } from '@/runtime/session/session-recovery';
import { authority, playingGame, room, waitingRoom } from '@/testing/game-fixtures';

const waitingView = {
  room: waitingRoom,
  game: null,
  presence: { roomId: authority.roomId, presenceVersion: 1, seats: [{ status: 'connected' }] },
};
const playingView = {
  room,
  game: playingGame,
  presence: {
    roomId: authority.roomId,
    presenceVersion: 2,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  },
};
function setup(saved: boolean, controlRecovery: boolean = false) {
  let recoveryTime = 0;
  let recoveryExpiry = () => {};
  let connected = () => {};
  let disconnected = () => {};
  let update = (_value: unknown) => {};
  let acknowledge: ((value: unknown) => void) | undefined;
  const socket: RawGameSocket = {
    connect: vi.fn(async () => connected()),
    disconnect: vi.fn(() => disconnected()),
    dispose: vi.fn(),
    emitCommand: vi.fn(),
    emitSync: vi.fn((callback) => {
      acknowledge = callback;
    }),
    onConnected: (listener) => {
      connected = listener;
      return () => {};
    },
    onDisconnected: (listener) => {
      disconnected = listener;
      return () => {};
    },
    onRoomUpdate: (listener) => {
      update = listener;
      return () => {};
    },
    onConnectionError: () => () => {},
    onReplaced: () => () => {},
  };
  const client = createGameClient({
    serverUrl: 'https://example.test',
    releaseId: 'integration',
    socketFactory: { create: () => socket },
  });
  vi.spyOn(client, 'createRoom').mockResolvedValue({
    ok: true,
    data: { authority, view: waitingView },
    meta: {},
  } as Awaited<ReturnType<typeof client.createRoom>>);
  vi.spyOn(client, 'joinRoom').mockResolvedValue({
    ok: true,
    data: { authority, view: playingView },
    meta: {},
  } as Awaited<ReturnType<typeof client.joinRoom>>);
  vi.spyOn(client, 'resumeRoom').mockResolvedValue({
    ok: true,
    data: { seatIndex: 0, view: waitingView },
    meta: {},
  } as Awaited<ReturnType<typeof client.resumeRoom>>);
  const values = new Map<string, string>();
  const sessionCredentialStore = createSessionCredentialStore({
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
  });
  sessionCredentialStore.initialize();
  if (saved) sessionCredentialStore.recordRoom(authority);
  const sessions = createGameSessionHolder(client);
  const readiness = { wait: async () => ({ ok: true as const }) };
  const reentry = createStoredRoomReentry({ client, readiness, sessions, sessionCredentialStore });
  const recovery = createSessionRecovery({
    sessions,
    subscribeForeground: () => () => {},
    ...(controlRecovery
      ? {
          now: () => recoveryTime,
          setTimeout: (callback: () => void) => {
            recoveryExpiry = callback;
            return 1;
          },
          clearTimeout: () => {},
        }
      : {}),
  });
  recovery.start();
  const access = createRoomAccess({
    activity: new AbortController().signal,
    client,
    sessions,
    sessionCredentialStore,
    readiness,
    reentry,
    recovery,
  });
  return {
    expireRecovery: () => {
      recoveryTime = 30_000;
      recoveryExpiry();
    },
    access,
    sessions,
    sessionCredentialStore,
    socket,
    reentry,
    recovery,
    drop: () => disconnected(),
    reconnect: () => connected(),
    liveGame: (game = playingGame) =>
      update({ type: 'state:committed', view: { ...playingView, game } }),
    sync: () =>
      acknowledge!({
        ok: true,
        data: waitingView,
        meta: {
          requestId: '11111111-1111-4111-8111-000000000003',
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
          serverTime: Date.now(),
        },
      }),
    rejectSync: (
      code:
        | typeof PUBLIC_ERROR_CODE.ROOM_NOT_FOUND
        | typeof PUBLIC_ERROR_CODE.INVALID_AUTHORITY
        | typeof PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE,
    ) =>
      acknowledge!({
        ok: false,
        error: { code, params: {} },
        meta: {
          requestId: '11111111-1111-4111-8111-000000000003',
          gameProtocolVersion: GAME_PROTOCOL_VERSION,
        },
      }),
    dispose() {
      access.dispose();
      reentry.dispose();
      recovery.dispose();
      sessions.dispose();
    },
  };
}
const profile = { characterId: 'navy-bob', variant: false } as const;

test.each(['create', 'join', 'restore'] as const)(
  'preserves authority and stops %s after the real SDK first full sync disconnects',
  async (kind) => {
    const fixture = setup(kind === 'restore');
    try {
      if (kind === 'restore') fixture.access.checkStoredRoom();
      else if (kind === 'create')
        await fixture.access.create(profile, new AbortController().signal);
      else await fixture.access.join({ profile, roomCode: '001234' }, new AbortController().signal);
      await vi.waitFor(() => expect(fixture.socket.emitSync).toHaveBeenCalledOnce());
      expect(fixture.sessions.getSnapshot().sessionSnapshot?.syncRevision).toBe(0);
      fixture.drop();
      await vi.waitFor(() =>
        expect(fixture.access.getSnapshot()).toMatchObject({
          status: kind === 'restore' ? 'refreshRequired' : 'connectionFailure',
          error: { kind: 'protocol', code: CLIENT_ERROR_CODE.SESSION_DISPOSED },
        }),
      );
      expect(fixture.socket.disconnect).toHaveBeenCalledOnce();
      expect(fixture.sessions.getSnapshot().authority).toEqual(authority);
      expect(fixture.sessionCredentialStore.refreshRecentRoom()).toEqual({
        status: 'ready',
        room: { roomId: authority.roomId, seatToken: authority.seatToken },
      });
      expect(fixture.recovery.getSnapshot().status).toBe('idle');
    } finally {
      fixture.dispose();
    }
  },
);

test('keeps pending saved restore failure above its unconfirmed live Game', async () => {
  const fixture = setup(true, true);
  try {
    fixture.access.checkStoredRoom();
    await vi.waitFor(() => expect(fixture.socket.emitSync).toHaveBeenCalledOnce());
    fixture.liveGame();
    expect(fixture.sessions.getSnapshot().sessionSnapshot?.game).toEqual(playingGame);
    expect(fixture.access.getSnapshot().status).toBe('restoring');
    fixture.drop();
    await vi.waitFor(() =>
      expect(fixture.access.getSnapshot()).toMatchObject({
        status: 'refreshRequired',
        origin: 'restore',
      }),
    );
    expect(fixture.socket.disconnect).toHaveBeenCalledOnce();
    fixture.recovery.requestSynchronization();
    fixture.expireRecovery();
    expect(fixture.recovery.getSnapshot().status).toBe('refreshRequired');
    expect(fixture.socket.emitSync).toHaveBeenCalledOnce();
    expect(fixture.socket.connect).toHaveBeenCalledOnce();
    expect(fixture.access.getSnapshot()).toMatchObject({
      status: 'refreshRequired',
      origin: 'restore',
    });
  } finally {
    fixture.dispose();
  }
});

test('keeps a new live Game in recovery when it precedes first full sync confirmation', async () => {
  const fixture = setup(false);
  try {
    await fixture.access.join({ profile, roomCode: '001234' }, new AbortController().signal);
    await vi.waitFor(() => expect(fixture.socket.emitSync).toHaveBeenCalledOnce());
    fixture.liveGame();
    expect(fixture.sessions.getSnapshot().sessionSnapshot?.syncRevision).toBe(0);
    expect(fixture.access.getSnapshot()).toMatchObject({ status: 'handoff', target: 'game' });
    fixture.drop();
    await vi.waitFor(() => expect(fixture.recovery.getSnapshot().status).toBe('reconnecting'));
    await Promise.resolve();
    expect(fixture.access.getSnapshot()).toMatchObject({ status: 'handoff', target: 'game' });
    expect(fixture.socket.disconnect).not.toHaveBeenCalled();
  } finally {
    fixture.dispose();
  }
});

test('recovers authenticated waiting after its first successful full sync', async () => {
  const fixture = setup(false);
  try {
    await fixture.access.create(profile, new AbortController().signal);
    await vi.waitFor(() => expect(fixture.socket.emitSync).toHaveBeenCalledOnce());
    fixture.sync();
    await vi.waitFor(() =>
      expect(fixture.sessions.getSnapshot().sessionSnapshot?.syncRevision).toBe(1),
    );
    await Promise.resolve();
    fixture.drop();
    expect(fixture.access.getSnapshot()).toMatchObject({
      status: 'waiting',
      recovery: 'reconnecting',
    });
    fixture.reconnect();
    fixture.sync();
    await vi.waitFor(() =>
      expect(fixture.access.getSnapshot()).toMatchObject({ status: 'waiting', recovery: 'idle' }),
    );
    expect(fixture.socket.disconnect).not.toHaveBeenCalled();
  } finally {
    fixture.dispose();
  }
});

test.each([
  PUBLIC_ERROR_CODE.ROOM_NOT_FOUND,
  PUBLIC_ERROR_CODE.INVALID_AUTHORITY,
  PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE,
])(
  'confirms %s from pending saved first sync instead of handing off its live Game',
  async (code) => {
    const fixture = setup(true);
    try {
      fixture.access.checkStoredRoom();
      await vi.waitFor(() => expect(fixture.socket.emitSync).toHaveBeenCalledOnce());
      fixture.liveGame();
      expect(fixture.sessions.getSnapshot().sessionSnapshot?.syncRevision).toBe(0);
      fixture.rejectSync(code);
      await vi.waitFor(() =>
        expect(fixture.reentry.getSnapshot()).toMatchObject({ status: 'permanentFailure' }),
      );
      expect(fixture.access.getSnapshot()).toMatchObject({
        status: 'authorityFailure',
        origin: 'restore',
        error: { kind: 'server', error: { code } },
      });
      expect(fixture.sessions.getSnapshot().authority).toEqual(authority);
      fixture.access.confirmAuthorityFailure();
      expect(fixture.access.getSnapshot()).toEqual({ status: 'idle' });
      expect(fixture.sessions.getSnapshot().authority).toBeNull();
      expect(fixture.sessionCredentialStore.refreshRecentRoom()).toEqual({
        status: 'ready',
        room: null,
      });
    } finally {
      fixture.dispose();
    }
  },
);

test('hands off a newer Game when confirming the former saved restore failure', async () => {
  const fixture = setup(true);
  try {
    fixture.access.checkStoredRoom();
    await vi.waitFor(() => expect(fixture.socket.emitSync).toHaveBeenCalledOnce());
    fixture.liveGame();
    fixture.rejectSync(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND);
    await vi.waitFor(() =>
      expect(fixture.access.getSnapshot()).toMatchObject({ status: 'authorityFailure' }),
    );
    const newerGame = parseGameSnapshot({
      ...playingGame,
      stateVersion: playingGame.stateVersion + 1,
    });
    fixture.liveGame(newerGame);
    const currentSession = fixture.sessions.getSnapshot().session;
    fixture.access.confirmAuthorityFailure();
    expect(fixture.reentry.getSnapshot()).toEqual({ status: 'idle' });
    expect(fixture.access.getSnapshot()).toMatchObject({ status: 'handoff', target: 'game' });
    expect(fixture.sessions.getSnapshot().session).toBe(currentSession);
    expect(fixture.sessions.getSnapshot().sessionSnapshot?.game).toEqual(newerGame);
    expect(fixture.sessions.getSnapshot().authority).toEqual(authority);
    expect(fixture.sessionCredentialStore.refreshRecentRoom()).toEqual({
      status: 'ready',
      room: { roomId: authority.roomId, seatToken: authority.seatToken },
    });
  } finally {
    fixture.dispose();
  }
});
