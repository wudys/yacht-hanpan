import { createGameClient } from '@repo/game-client-sdk';
import { afterEach, describe, expect, test } from 'bun:test';

import type { GameServer } from '@/app/start-game-server';
import { startGameServer } from '@/app/start-game-server';

const CLIENT_ONE = '01890f47-e89b-7cc3-98c5-4c5da03f78aa';
const CLIENT_TWO = '01890f47-e89b-7cc3-98c5-4c5da03f78ac';

describe('game-client-sdk with the real game server', () => {
  let server: GameServer | null = null;
  const sessions: Array<ReturnType<ReturnType<typeof createGameClient>['createSession']>> = [];

  afterEach(async () => {
    sessions.forEach((session) => session.dispose());
    sessions.length = 0;
    await server?.close();
    server = null;
  });

  test('bootstraps, commands, receives authoritative state, and reconnects by full sync', async () => {
    server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: 'game-client-integration',
      },
    });
    const client = createGameClient({
      serverUrl: server.url,
      releaseId: 'game-client-integration',
      retryPolicy: { acknowledgementTimeoutMs: 2_000, maximumAttempts: 2, retryDelayMs: 5 },
    });

    const created = await client.createRoom({
      clientId: CLIENT_ONE,
      profile: { characterId: 'navy-bob', variant: false },
    });
    expect(created.ok).toBeTrue();
    if (!created.ok) throw new Error('expected room creation');
    const joined = await client.joinRoom({
      clientId: CLIENT_TWO,
      roomCode: created.data.view.room.roomCode,
      profile: { characterId: 'blonde-buns', variant: false },
    });
    expect(joined.ok).toBeTrue();
    if (!joined.ok) throw new Error('expected room join');

    const creator = client.createSession(created.data.authority);
    const joiner = client.createSession(joined.data.authority);
    sessions.push(creator, joiner);
    expect(
      (await Promise.all([creator.connect(), joiner.connect()])).every((result) => result.ok),
    ).toBeTrue();

    const creatorGame = creator.getSnapshot().game;
    if (creatorGame?.match.status !== 'playing') throw new Error('expected playing snapshot');
    const { match } = creatorGame;
    const active =
      match.currentTurn.seatIndex === created.data.authority.seatIndex ? creator : joiner;
    const beforeVersion = Number(active.getSnapshot().game?.stateVersion);
    const rolled = await active.rollDice();
    expect(rolled.ok).toBeTrue();
    if (!rolled.ok) throw new Error('expected authoritative roll');
    await waitFor(
      () => Number(active.getSnapshot().game?.stateVersion) === rolled.data.stateVersion,
    );
    expect(Number(active.getSnapshot().game?.stateVersion)).toBe(beforeVersion + 1);
    expect('roll' in rolled.data).toBeTrue();

    active.disconnect();
    await waitFor(() => active.getSnapshot().connection === 'disconnected');
    expect((await active.connect()).ok).toBeTrue();
    expect(Number(active.getSnapshot().game?.stateVersion)).toBe(rolled.data.stateVersion);
  }, 20_000);

  test('cancels a waiting room through the public HTTP client', async () => {
    server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: 'game-client-cancel-integration',
      },
    });
    const client = createGameClient({
      serverUrl: server.url,
      releaseId: 'game-client-cancel-integration',
    });
    const created = await client.createRoom({
      clientId: CLIENT_ONE,
      profile: { characterId: 'navy-bob', variant: false },
    });
    if (!created.ok) throw new Error('expected room creation');

    const cancelled = await client.cancelRoom({
      roomId: created.data.authority.roomId,
      seatToken: created.data.authority.seatToken,
    });

    expect(cancelled).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(
      await client.resumeRoom({
        roomId: created.data.authority.roomId,
        seatToken: created.data.authority.seatToken,
      }),
    ).toMatchObject({ ok: false, error: { kind: 'server' } });
  }, 20_000);

  test('keeps one session from waiting presence through the initial game broadcast', async () => {
    server = await startGameServer({
      config: {
        allowedOrigins: [],
        trustRenderProxy: false,
        host: '127.0.0.1',
        port: 0,
        releaseId: 'game-client-waiting-integration',
      },
    });
    const client = createGameClient({
      serverUrl: server.url,
      releaseId: 'game-client-waiting-integration',
    });
    const created = await client.createRoom({
      clientId: CLIENT_ONE,
      profile: { characterId: 'navy-bob', variant: false },
    });
    if (!created.ok) throw new Error('expected room creation');
    const creator = client.createSession(created.data.authority);
    sessions.push(creator);

    expect(await creator.connect()).toMatchObject({ ok: true });
    expect(creator.getSnapshot()).toMatchObject({
      connection: 'connected',
      game: null,
      presence: { seats: [{ status: 'connected' }] },
    });

    const joined = await client.joinRoom({
      clientId: CLIENT_TWO,
      roomCode: created.data.view.room.roomCode,
      profile: { characterId: 'blonde-buns', variant: false },
    });
    expect(joined.ok).toBeTrue();
    await waitFor(() => creator.getSnapshot().game?.match.status === 'playing');
    expect(creator.getSnapshot().presence?.seats).toHaveLength(2);
  }, 20_000);
});

async function waitFor(predicate: () => boolean, timeoutMs: number = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition not reached');
    await Bun.sleep(5);
  }
}
