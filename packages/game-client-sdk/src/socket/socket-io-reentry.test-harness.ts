import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { SOCKET_EVENT } from '@repo/game-protocol/socket';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { expect, jest, mock } from 'bun:test';
import { Manager, Socket } from 'socket.io-client';

import {
  AUTHORITY,
  game,
  REQUEST_ID,
  syncResponse,
  viewFromGame,
} from '../session/game-session.test-fixtures';

// Use Socket.IO's actual emitter dispatch order, with only network I/O substituted.
let connectCount = 0;
let disconnectCount = 0;
class AuthenticationSocket extends Socket {
  public override connect(): this {
    connectCount += 1;
    return this;
  }
  public override disconnect(): this {
    disconnectCount += 1;
    this.connected = false;
    this.emitReserved('disconnect', 'io client disconnect');
    return this;
  }
  public rejectAuthentication(error: Error): void {
    this.emitReserved('connect_error', error);
  }
  public acceptAuthentication(): void {
    this.connected = true;
    this.emitReserved('connect');
  }
}
const transport = new AuthenticationSocket(
  new Manager('https://game.example.test', { autoConnect: false }),
  '/',
);
Object.defineProperty(transport, 'emit', {
  value: (event: string, acknowledge: unknown) => {
    if (event === SOCKET_EVENT.GAME_SYNC && typeof acknowledge === 'function') {
      acknowledge(syncResponse(viewFromGame(game(1))));
    }
    return transport;
  },
});
await mock.module('socket.io-client', () => ({ io: () => transport }));
const { createGameSession } = await import('../session/game-session');
const session = createGameSession({
  socketUrl: 'https://game.example.test',
  authority: AUTHORITY,
  contract: createCompatibilityContract('test'),
});
const reconnects: ReturnType<typeof session.connect>[] = [];
session.subscribe(() => {
  const snapshot = session.getSnapshot();
  if (
    snapshot.connection === 'disconnected' &&
    snapshot.error !== null &&
    reconnects.length === 0
  ) {
    reconnects.push(session.connect());
  }
});

try {
  jest.useFakeTimers();
  const first = session.connect();
  transport.rejectAuthentication(
    Object.assign(new Error('authentication failed'), {
      data: {
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
        meta: { requestId: REQUEST_ID, gameProtocolVersion: GAME_PROTOCOL_VERSION },
      },
    }),
  );
  expect(connectCount).toBe(2);
  expect(await first).toMatchObject({
    ok: false,
    error: { kind: 'server', error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY } },
  });
  jest.advanceTimersByTime(5_000);
  session.disconnect();
  expect(await Promise.all(reconnects)).toMatchObject([
    { ok: false, error: { code: 'SOCKET_DISCONNECTED' } },
  ]);

  jest.advanceTimersByTime(5_000);
  const third = session.connect();
  expect(connectCount).toBe(3);
  // The cancelled second authentication's original deadline expires halfway through the third.
  jest.advanceTimersByTime(10_000);
  await Promise.resolve();
  expect(disconnectCount).toBe(1);
  expect(session.getSnapshot()).toMatchObject({ connection: 'connecting', syncRevision: 0 });

  transport.acceptAuthentication();
  expect(await third).toEqual({ ok: true });
  const confirmed = session.getSnapshot();
  jest.advanceTimersByTime(20_000);
  await Promise.resolve();
  expect(session.getSnapshot()).toBe(confirmed);
  expect(confirmed).toMatchObject({ connection: 'connected', syncStatus: 'idle', syncRevision: 1 });
  expect(disconnectCount).toBe(1);
} finally {
  session.dispose();
  jest.useRealTimers();
}
