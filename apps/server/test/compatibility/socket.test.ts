import { afterEach, describe, expect, test } from 'bun:test';
import { io, type Socket } from 'socket.io-client';

import { type CompatibilitySocketServer, startCompatibilitySocketServer } from './socket-server';

const clients: Socket[] = [];
let server: CompatibilitySocketServer | undefined;

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await server?.close();
  server = undefined;
});

describe('Bun Socket.IO compatibility', () => {
  test('supports websocket ack and room-scoped events', async () => {
    server = await startCompatibilitySocketServer();
    const first = await connect(server.url);
    const second = await connect(server.url);
    const outsider = await connect(server.url);

    expect(
      await first.timeout(1_000).emitWithAck('compatibility:ping', { nonce: 'ping-1' }),
    ).toEqual({ nonce: 'ping-1', runtime: 'bun' });

    expect(
      await first.timeout(1_000).emitWithAck('compatibility:join', { roomId: 'room-a' }),
    ).toEqual({ joined: true });
    expect(
      await second.timeout(1_000).emitWithAck('compatibility:join', { roomId: 'room-a' }),
    ).toEqual({ joined: true });

    let outsiderReceived = false;
    outsider.on('compatibility:message', () => {
      outsiderReceived = true;
    });

    const message = waitForEvent<{ roomId: string; value: string }>(
      second,
      'compatibility:message',
    );
    first.emit('compatibility:message', { roomId: 'room-a', value: 'room-only' });

    expect(await message).toEqual({ roomId: 'room-a', value: 'room-only' });
    await Bun.sleep(25);
    expect(outsiderReceived).toBeFalse();
  });

  test('closes idempotently without waiting for the unsupported HTTP close callback', async () => {
    server = await startCompatibilitySocketServer();
    const healthUrl = `${server.url}/health`;
    expect((await fetch(healthUrl)).status).toBe(200);

    await server.close();
    await server.close();
    server = undefined;

    expect(await fetch(healthUrl).catch(() => null)).toBeNull();
  });
});

async function connect(url: string): Promise<Socket> {
  const client = io(url, {
    forceNew: true,
    reconnection: false,
    transports: ['websocket'],
  });
  clients.push(client);
  await waitForEvent(client, 'connect');
  return client;
}

async function waitForEvent<T = void>(socket: Socket, event: string): Promise<T> {
  return await Promise.race([
    new Promise<T>((resolve) => socket.once(event, resolve)),
    Bun.sleep(1_000).then(() => {
      throw new Error(`Timed out waiting for ${event}`);
    }),
  ]);
}
