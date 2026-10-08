import assert from 'node:assert/strict';

import { type ClientError, createGameClient, type RoomAuthority } from '@repo/game-client-sdk';
import { parseRoomView, type RoomView } from '@repo/game-protocol/state';
import { CATEGORY_ID } from '@repo/yacht-rules';
import { v7 as uuidV7 } from 'uuid';

import { type GameServer, startGameServer } from '@/app/start-game-server';
import { RECONNECT_GRACE_MS, WAITING_ROOM_LIFETIME_MS } from '@/rooms/domain/room-constants';

const ROOM_COUNT = 25;
const USER_COUNT = ROOM_COUNT * 2;
const MAX_RSS_BYTES = 384 * 1_024 * 1_024;
const RELEASE_ID = 'server-load-v1';

type GameClient = ReturnType<typeof createGameClient>;
type GameSession = ReturnType<GameClient['createSession']>;

interface LoadedRoom {
  readonly creatorAuthority: RoomAuthority;
  readonly joinerAuthority: RoomAuthority;
}

let httpAddressIndex = 0;
let socketAddressIndex = 0;
let clockOffsetMs = 0;
let server: GameServer | null = null;
const sessions: GameSession[] = [];

const startedAt = performance.now();

try {
  server = await startGameServer({
    clock: { now: () => Date.now() + clockOffsetMs },
    config: {
      allowedOrigins: [],
      trustRenderProxy: false,
      host: '127.0.0.1',
      port: 0,
      releaseId: RELEASE_ID,
    },
    logger: {
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn: () => undefined,
    },
    resolveClientAddress: () => `load-http-${httpAddressIndex++}`,
    resolveSocketClientAddress: () => `load-socket-${Math.floor(socketAddressIndex++ / 2)}`,
  });
  const rssBefore = process.memoryUsage.rss();
  const client = createGameClient({
    serverUrl: server.url,
    releaseId: RELEASE_ID,
    httpTimeoutMs: 20_000,
    retryPolicy: { acknowledgementTimeoutMs: 10_000, maximumAttempts: 2, retryDelayMs: 5 },
  });

  const bootstrapStartedAt = performance.now();
  const creatorClientIds = Array.from({ length: ROOM_COUNT }, () => uuidV7());
  const createdRooms = await Promise.all(
    creatorClientIds.map((clientId, index) =>
      client.createRoom({
        clientId,
        profile: { characterId: index % 2 === 0 ? 'navy-bob' : 'blonde-buns', variant: false },
      }),
    ),
  );
  const joinInputs = createdRooms.map((created, index) => {
    if (!created.ok) throw new Error(`Room ${index} create failed: ${errorCode(created.error)}`);
    assert.equal(created.data.authority.seatIndex, 0);
    const view = checkRoomView(created.data.view, created.data.authority, 'waiting');
    assert.equal(view.game, null);
    assert.equal(view.presence.presenceVersion, 0);
    assert.equal(view.presence.seats[0].status, 'disconnected');
    return {
      creatorAuthority: created.data.authority,
      join: client.joinRoom({
        clientId: uuidV7(),
        profile: { characterId: index % 2 === 0 ? 'blonde-buns' : 'navy-bob', variant: false },
        roomCode: created.data.view.room.roomCode,
      }),
    };
  });
  const joinedRooms = await Promise.all(joinInputs.map(({ join }) => join));
  const rooms: LoadedRoom[] = joinedRooms.map((joined, index) => {
    if (!joined.ok) throw new Error(`Room ${index} join failed: ${errorCode(joined.error)}`);
    const { creatorAuthority } = joinInputs[index]!;
    assert.equal(joined.data.authority.seatIndex, 1);
    assert.equal(joined.data.authority.roomId, creatorAuthority.roomId);
    const view = checkRoomView(joined.data.view, joined.data.authority, 'playing');
    assert.equal(view.game?.stateVersion, 1);
    assert.equal(view.presence.presenceVersion, 1);
    return {
      creatorAuthority: joinInputs[index]!.creatorAuthority,
      joinerAuthority: joined.data.authority,
    };
  });
  const bootstrapDurationMs = performance.now() - bootstrapStartedAt;

  const connectStartedAt = performance.now();
  const sessionPairs = rooms.map(({ creatorAuthority, joinerAuthority }) => {
    const creator = client.createSession(creatorAuthority);
    const joiner = client.createSession(joinerAuthority);
    sessions.push(creator, joiner);
    return { creator, joiner };
  });
  const connections = await Promise.all(
    sessionPairs.flatMap(({ creator, joiner }) => [creator.connect(), joiner.connect()]),
  );
  connections.forEach((connection, index) => {
    if (!connection.ok) {
      throw new Error(`User ${index} connect failed: ${errorCode(connection.error)}`);
    }
  });
  await waitFor(() =>
    sessionPairs.every(({ creator, joiner }, index) => {
      const room = rooms[index]!;
      return (
        bothConnected(readSessionView(creator, room.creatorAuthority)) &&
        bothConnected(readSessionView(joiner, room.joinerAuthority))
      );
    }),
  );
  sessionPairs.forEach(({ creator, joiner }, index) => {
    const room = rooms[index]!;
    const creatorView = readSessionView(creator, room.creatorAuthority);
    const joinerView = readSessionView(joiner, room.joinerAuthority);
    assert.equal(creatorView.game?.stateVersion, 1);
    assert.deepEqual(creatorView, joinerView);
  });
  const connectDurationMs = performance.now() - connectStartedAt;

  const gameplayStartedAt = performance.now();
  const activeSessions = sessionPairs.map(({ creator, joiner }, index) => {
    const { game } = creator.getSnapshot();
    if (game?.match.status !== 'playing') throw new Error(`Room ${index} did not start`);
    const { match } = game;
    return match.currentTurn.seatIndex === rooms[index]!.creatorAuthority.seatIndex
      ? creator
      : joiner;
  });
  const initialTurns = activeSessions.map((session, index) => {
    const room = rooms[index]!;
    const authority =
      session === sessionPairs[index]!.creator ? room.creatorAuthority : room.joinerAuthority;
    const view = readSessionView(session, authority);
    assert(view.game?.match.status === 'playing');
    assert.equal(view.game.match.currentTurn.seatIndex, authority.seatIndex);
    return view.game.match.currentTurn;
  });
  const rolls = await Promise.all(activeSessions.map((session) => session.rollDice()));
  rolls.forEach((roll, index) => {
    if (!roll.ok) throw new Error(`Room ${index} roll failed: ${errorCode(roll.error)}`);
    assert.equal(roll.data.stateVersion, 2);
  });
  const rolledVersions = rolls.map((roll) => {
    if (!roll.ok) throw new Error('Unreachable failed roll result');
    return roll.data.stateVersion;
  });
  await waitFor(() =>
    sessionPairs.every(({ creator, joiner }, index) => {
      const room = rooms[index]!;
      return (
        readSessionView(creator, room.creatorAuthority).game?.stateVersion ===
          rolledVersions[index] &&
        readSessionView(joiner, room.joinerAuthority).game?.stateVersion === rolledVersions[index]
      );
    }),
  );
  const expectedOnes = sessionPairs.map(({ creator, joiner }, index) => {
    const room = rooms[index]!;
    const creatorView = readSessionView(creator, room.creatorAuthority);
    const joinerView = readSessionView(joiner, room.joinerAuthority);
    assert.deepEqual(creatorView, joinerView);
    assert(creatorView.game?.match.status === 'playing');
    const turn = creatorView.game.match.currentTurn;
    assert.equal(turn.turnId, initialTurns[index]!.turnId);
    assert.equal(turn.seatIndex, initialTurns[index]!.seatIndex);
    assert(turn.rollCount === 1);
    const roll = rolls[index]!;
    assert(roll.ok && 'roll' in roll.data);
    assert.deepEqual(
      turn.dice.map((die, slot) => ({ slot, value: die.value })),
      roll.data.roll.outcome.authoritativeValuesBySlot,
    );
    return turn.dice.filter(({ value }) => value === 1).length;
  });
  const scores = await Promise.all(
    activeSessions.map((session) => session.selectScoreCategory(CATEGORY_ID.ONES)),
  );
  scores.forEach((score, index) => {
    if (!score.ok) throw new Error(`Room ${index} score failed: ${errorCode(score.error)}`);
  });
  const expectedStateVersions = scores.map((score) => {
    if (!score.ok) throw new Error('Unreachable failed score result');
    return score.data.stateVersion;
  });
  await waitFor(() =>
    sessionPairs.every(({ creator, joiner }, index) => {
      const room = rooms[index]!;
      return (
        readSessionView(creator, room.creatorAuthority).game?.stateVersion ===
          expectedStateVersions[index] &&
        readSessionView(joiner, room.joinerAuthority).game?.stateVersion ===
          expectedStateVersions[index]
      );
    }),
  );
  sessionPairs.forEach(({ creator, joiner }, index) => {
    const room = rooms[index]!;
    const creatorView = readSessionView(creator, room.creatorAuthority);
    const joinerView = readSessionView(joiner, room.joinerAuthority);
    assert.deepEqual(creatorView, joinerView);
    assert.equal(expectedStateVersions[index], rolledVersions[index]! + 1);
    assert(creatorView.game?.match.status === 'playing');
    const { match } = creatorView.game;
    const originalTurn = initialTurns[index]!;
    assert.equal(
      match.players[originalTurn.seatIndex].scorecard[CATEGORY_ID.ONES],
      expectedOnes[index],
    );
    assert.notEqual(match.currentTurn.turnId, originalTurn.turnId);
    assert.equal(match.currentTurn.seatIndex, originalTurn.seatIndex === 0 ? 1 : 0);
    assert.equal(match.currentTurn.rollCount, 0);
    assert.equal(match.currentTurn.dice, null);
  });
  const gameplayDurationMs = performance.now() - gameplayStartedAt;

  const reentryStartedAt = performance.now();
  sessionPairs.forEach(({ creator }) => creator.disconnect());
  const resumedRooms = await Promise.all(
    rooms.map(({ creatorAuthority }) =>
      client.resumeRoom({
        roomId: creatorAuthority.roomId,
        seatToken: creatorAuthority.seatToken,
      }),
    ),
  );
  resumedRooms.forEach((resumed, index) => {
    if (!resumed.ok) throw new Error(`Room ${index} resume failed: ${errorCode(resumed.error)}`);
    assert.equal(resumed.data.seatIndex, rooms[index]!.creatorAuthority.seatIndex);
    const view = checkRoomView(resumed.data.view, rooms[index]!.creatorAuthority, 'playing');
    assert.equal(view.game?.stateVersion, expectedStateVersions[index]);
  });
  sessionPairs.forEach(({ creator }) => creator.dispose());
  const reenteredCreators = rooms.map(({ creatorAuthority }) => {
    const session = client.createSession(creatorAuthority);
    sessions.push(session);
    return session;
  });
  const reentries = await Promise.all(reenteredCreators.map((session) => session.connect()));
  reentries.forEach((reentry, index) => {
    if (!reentry.ok) throw new Error(`Room ${index} reentry failed: ${errorCode(reentry.error)}`);
  });
  await waitFor(() =>
    reenteredCreators.every((session, index) => {
      const room = rooms[index]!;
      const restored = readSessionView(session, room.creatorAuthority);
      const peer = readSessionView(sessionPairs[index]!.joiner, room.joinerAuthority);
      return (
        restored.game?.stateVersion === expectedStateVersions[index] &&
        peer.game?.stateVersion === expectedStateVersions[index] &&
        restored.presence.presenceVersion === peer.presence.presenceVersion &&
        bothConnected(restored) &&
        bothConnected(peer)
      );
    }),
  );
  reenteredCreators.forEach((session, index) => {
    const room = rooms[index]!;
    assert.deepEqual(
      readSessionView(session, room.creatorAuthority),
      readSessionView(sessionPairs[index]!.joiner, room.joinerAuthority),
    );
  });
  const reentryDurationMs = performance.now() - reentryStartedAt;

  const telemetry = server.telemetry.snapshot();
  const rssBytes = process.memoryUsage.rss();
  const rssDeltaBytes = rssBytes - rssBefore;
  const report = {
    bunVersion: Bun.version,
    rooms: ROOM_COUNT,
    users: USER_COUNT,
    bootstrapDurationMs: rounded(bootstrapDurationMs),
    connectDurationMs: rounded(connectDurationMs),
    gameplayDurationMs: rounded(gameplayDurationMs),
    reentryDurationMs: rounded(reentryDurationMs),
    totalDurationMs: rounded(performance.now() - startedAt),
    rssBytes,
    rssDeltaBytes,
    telemetry,
  };
  if (telemetry.rooms.records !== ROOM_COUNT || telemetry.rooms.codeIndex !== ROOM_COUNT) {
    throw new Error(`Unexpected room telemetry: ${JSON.stringify(telemetry.rooms)}`);
  }
  if (telemetry.rooms.actionLedgerEntries !== ROOM_COUNT * 2 || telemetry.actions.pending !== 0) {
    throw new Error(`Unexpected action telemetry: ${JSON.stringify(telemetry)}`);
  }
  if (telemetry.presence.rooms !== ROOM_COUNT || telemetry.presence.connections !== USER_COUNT) {
    throw new Error(`Unexpected presence telemetry: ${JSON.stringify(telemetry.presence)}`);
  }
  if (
    telemetry.retention.transports !== USER_COUNT ||
    telemetry.retention.authenticating !== 0 ||
    telemetry.retention.httpRequests !== 0 ||
    telemetry.retention.roomRequests !== 0 ||
    telemetry.retention.queueRooms !== 0
  ) {
    throw new Error(
      `Unexpected transport/request retention: ${JSON.stringify(telemetry.retention)}`,
    );
  }
  if (
    !telemetry.workers.enabled ||
    telemetry.workers.ready !== 1 ||
    telemetry.workers.running !== 0 ||
    telemetry.workers.queued !== 0 ||
    telemetry.workers.restarts !== 0
  ) {
    throw new Error(`Unexpected worker telemetry: ${JSON.stringify(telemetry.workers)}`);
  }
  if (rssBytes > MAX_RSS_BYTES) {
    throw new Error(`RSS reached ${rssBytes} bytes`);
  }

  // Losing a room credential must not make clientId a waiting-room lock.
  // Separate operations from one client may create separate rooms within the IP quota.
  const waitingRooms = await Promise.all(
    creatorClientIds.flatMap((clientId) =>
      Array.from({ length: 2 }, () =>
        client.createRoom({
          clientId,
          profile: { characterId: 'navy-bob', variant: false },
        }),
      ),
    ),
  );
  waitingRooms.forEach((result, index) => {
    if (!result.ok) throw new Error(`Waiting room ${index} failed: ${errorCode(result.error)}`);
    const view = checkRoomView(result.data.view, result.data.authority, 'waiting');
    assert.equal(view.presence.presenceVersion, 0);
  });
  const waitingRoomCount = waitingRooms.length;

  // Both seats may return during their original grace period. Periodic maintenance
  // must not reclaim these rooms simply because all transports are absent.
  const disconnectStartedAt = performance.now();
  sessions.forEach((session) => session.dispose());
  const runningServer = server;
  await waitFor(() => runningServer.telemetry.snapshot().presence.connections === 0);
  await Bun.sleep(30_000);
  const retainedAfterDisconnect = runningServer.telemetry.snapshot();
  if (retainedAfterDisconnect.rooms.records !== ROOM_COUNT + waitingRoomCount) {
    throw new Error('Cleanup removed disconnected rooms before their reconnect deadlines');
  }

  // Keep the real production clock and scheduler: this also observes memory
  // retention across the full grace interval, beyond the fast policy tests.
  await Bun.sleep(RECONNECT_GRACE_MS - 30_000);
  await waitFor(
    () => runningServer.telemetry.snapshot().rooms.records === waitingRoomCount,
    35_000,
  );
  const afterPlayingCleanup = runningServer.telemetry.snapshot();
  if (
    afterPlayingCleanup.rooms.codeIndex !== waitingRoomCount ||
    afterPlayingCleanup.rooms.actionLedgerEntries !== 0 ||
    afterPlayingCleanup.actions.pending !== 0 ||
    afterPlayingCleanup.presence.rooms !== 0 ||
    afterPlayingCleanup.presence.connections !== 0
  ) {
    throw new Error(`Disconnected room resources leaked: ${JSON.stringify(afterPlayingCleanup)}`);
  }
  // All gameplay has ended. Advance only this final waiting-room expiry check;
  // the reconnect interval above used the real clock and real scheduler.
  clockOffsetMs = WAITING_ROOM_LIFETIME_MS;
  await waitFor(() => runningServer.telemetry.snapshot().rooms.records === 0, 35_000);
  const afterCleanup = runningServer.telemetry.snapshot();
  if (afterCleanup.rooms.records !== 0 || afterCleanup.rooms.codeIndex !== 0) {
    throw new Error(`Expired waiting rooms leaked: ${JSON.stringify(afterCleanup.rooms)}`);
  }
  if (Object.values(afterCleanup.retention).some((count) => count !== 0)) {
    throw new Error(`Idle resources leaked: ${JSON.stringify(afterCleanup.retention)}`);
  }
  const rssAfterGraceBytes = process.memoryUsage.rss();
  if (rssAfterGraceBytes > MAX_RSS_BYTES) {
    throw new Error(`RSS after reconnect grace reached ${rssAfterGraceBytes} bytes`);
  }
  console.log(
    JSON.stringify({
      ...report,
      totalDurationMs: rounded(performance.now() - startedAt),
      disconnectCleanupDurationMs: rounded(performance.now() - disconnectStartedAt),
      rssAfterGraceBytes,
      waitingRoomCount,
      retainedAfterDisconnect,
      afterPlayingCleanup,
      afterCleanup,
    }),
  );
} finally {
  sessions.forEach((session) => session.dispose());
  await server?.close();
}

function checkRoomView(
  value: unknown,
  authority: RoomAuthority,
  status: 'waiting' | 'playing',
): RoomView {
  const view = parseRoomView(value);
  assert.equal(view.room.roomId, authority.roomId);
  assert.equal(view.presence.roomId, authority.roomId);
  assert.equal(view.room.status, status);
  assert.equal(view.room.seats.length, status === 'waiting' ? 1 : 2);
  assert.equal(view.presence.seats.length, view.room.seats.length);
  assert(view.room.seats[authority.seatIndex] !== undefined);
  assert.equal(view.game?.match.status ?? null, status === 'waiting' ? null : 'playing');
  return view;
}

function readSessionView(session: GameSession, authority: RoomAuthority): RoomView {
  const { room, game, presence } = session.getSnapshot();
  return checkRoomView({ room, game, presence }, authority, 'playing');
}

function bothConnected(view: RoomView): boolean {
  return view.presence.seats.every(({ status }) => status === 'connected');
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function errorCode(error: ClientError): string {
  return error.kind === 'server' ? error.error.code : error.code;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!(await predicate())) {
    if (performance.now() >= deadline)
      throw new Error('Timed out waiting for server-load observation');
    await Bun.sleep(20);
  }
}
