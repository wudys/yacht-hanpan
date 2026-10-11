import { createGameClient, type RawGameSocket } from '@repo/game-client-sdk';
import { CLIENT_ERROR_CODE } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';
import { parseGameSnapshot } from '@repo/game-protocol/state';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { afterEach, expect, test, vi } from 'vitest';

import { createGameSessionHolder } from '@/runtime/session/game-session-holder';
import { createSessionRecovery } from '@/runtime/session/session-recovery';
import { authority, playingGame, room } from '@/testing/game-fixtures';

const view = {
  room,
  game: playingGame,
  presence: {
    roomId: authority.roomId,
    presenceVersion: 1,
    seats: [{ status: 'connected' }, { status: 'connected' }],
  },
};
const meta = {
  requestId: '11111111-1111-4111-8111-000000000003',
  gameProtocolVersion: GAME_PROTOCOL_VERSION,
  serverTime: 1_000,
};

afterEach(() => vi.useRealTimers());

test('real SDK ignores a late confirmation, coalesces foreground, and confirms live state with a fresh sync', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  let connected = () => {};
  let disconnected = () => {};
  let update = (_value: unknown) => {};
  let foreground = () => {};
  const acknowledgements: ((value: unknown) => void)[] = [];
  const socket: RawGameSocket = {
    connect: vi.fn(async () => connected()),
    disconnect: vi.fn(() => disconnected()),
    dispose: vi.fn(),
    emitCommand: vi.fn(),
    emitSync: vi.fn((acknowledge) => acknowledgements.push(acknowledge)),
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
    retryPolicy: {
      commandResponseTimeoutMs: 300,
      retryIntervalMs: 100,
      maximumAttempts: 3,
      synchronizationTimeoutMs: 100,
    },
  });
  const sessions = createGameSessionHolder(client);
  const session = sessions.installAuthority(authority);
  const initial = session.connect();
  acknowledgements[0]!({ ok: true, data: view, meta });
  expect(await initial).toEqual({ ok: true });
  const recovery = createSessionRecovery({
    sessions,
    now: Date.now,
    subscribeForeground: (listener) => {
      foreground = listener;
      return () => {};
    },
  });
  const attempts = vi.fn();
  recovery.subscribeAttempt(attempts);
  recovery.start();
  try {
    foreground();
    foreground();
    expect(acknowledgements).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(session.getSnapshot().error).toMatchObject({ code: CLIENT_ERROR_CODE.ACK_TIMEOUT });
    expect(session.getSnapshot().syncRevision).toBe(1);

    const newerView = { ...view, game: parseGameSnapshot({ ...playingGame, stateVersion: 8 }) };
    update({ type: 'state:committed', view: newerView });
    expect(session.getSnapshot().error).toBeNull();
    expect(recovery.getSnapshot().status).toBe('synchronizing');
    acknowledgements[1]!({ ok: true, data: newerView, meta });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().syncRevision).toBe(1);
    expect(recovery.getSnapshot().status).toBe('synchronizing');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(acknowledgements).toHaveLength(3);
    acknowledgements[2]!({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 2_000 } },
      meta,
    });
    await vi.advanceTimersByTimeAsync(0);
    foreground();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(acknowledgements).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(acknowledgements).toHaveLength(4);
    foreground();
    expect(acknowledgements).toHaveLength(4);
    acknowledgements[3]!({ ok: true, data: newerView, meta });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().syncRevision).toBe(2);
    expect(session.getSnapshot().game).toEqual(newerView.game);
    expect(recovery.getSnapshot()).toEqual({ status: 'idle' });
    expect(attempts.mock.calls).toEqual([
      [{ phase: 'started' }],
      [{ phase: 'finished', outcome: 'success', durationMs: 3_100 }],
    ]);
    acknowledgements[1]!({ ok: true, data: view, meta });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(session.getSnapshot().syncRevision).toBe(2);
    expect(session.getSnapshot().game).toEqual(newerView.game);
    expect(socket.disconnect).not.toHaveBeenCalled();
  } finally {
    recovery.dispose();
    sessions.dispose();
  }
});

test.each(['success', 'failure'] as const)(
  'command final confirmation ends with %s without an additional recovery episode',
  async (confirmation) => {
    vi.useFakeTimers();
    const commandAcks: ((value: unknown) => void)[] = [];
    const syncAcks: ((value: unknown) => void)[] = [];
    const socket: RawGameSocket = {
      connect: async () => {},
      disconnect: vi.fn(),
      dispose: vi.fn(),
      emitCommand: (_command, acknowledge) => {
        commandAcks.push(acknowledge);
      },
      emitSync: (acknowledge) => {
        syncAcks.push(acknowledge);
      },
      onConnected: () => () => {},
      onDisconnected: () => () => {},
      onRoomUpdate: () => () => {},
      onConnectionError: () => () => {},
      onReplaced: () => () => {},
    };
    const client = createGameClient({
      serverUrl: 'https://example.test',
      releaseId: 'integration',
      socketFactory: { create: () => socket },
    });
    const sessions = createGameSessionHolder(client);
    const session = sessions.installAuthority(authority);
    const connecting = session.connect();
    await vi.advanceTimersByTimeAsync(0);
    syncAcks[0]!({ ok: true, data: view, meta });
    await connecting;
    const recovery = createSessionRecovery({ sessions });
    const attempts = vi.fn();
    recovery.subscribeAttempt(attempts);
    recovery.start();
    try {
      const result = session.setDieHeld(0, true);
      let completed = false;
      void result.then(() => {
        completed = true;
      });
      await vi.advanceTimersByTimeAsync(9_300);
      expect(commandAcks).toHaveLength(3);
      expect(completed).toBe(false);
      expect(syncAcks).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(35_700);
      expect(syncAcks).toHaveLength(2);
      expect(session.getSnapshot()).toMatchObject({
        syncStatus: 'synchronizing',
        syncFailureRequiresRefresh: true,
      });
      expect(recovery.getSnapshot().status).toBe('synchronizing');
      expect(attempts).not.toHaveBeenCalled();
      if (confirmation === 'success') syncAcks[1]!({ ok: true, data: view, meta });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await result).toMatchObject({
        ok: false,
        error: { code: CLIENT_ERROR_CODE.ACK_TIMEOUT },
      });
      expect(await result).not.toHaveProperty('retry');
      expect(session.getSnapshot()).toMatchObject({
        syncFailureRequiresRefresh: confirmation === 'failure',
        syncRevision: confirmation === 'success' ? 2 : 1,
      });
      expect(recovery.getSnapshot().status).toBe(
        confirmation === 'success' ? 'idle' : 'refreshRequired',
      );
      await vi.advanceTimersByTimeAsync(30_000);
      expect(syncAcks).toHaveLength(2);
      expect(commandAcks).toHaveLength(3);
      expect(socket.disconnect).toHaveBeenCalledTimes(confirmation === 'success' ? 0 : 1);
    } finally {
      recovery.dispose();
      sessions.dispose();
    }
  },
);
