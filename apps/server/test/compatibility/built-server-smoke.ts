import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGameClient, type GameSession } from '@repo/game-client-sdk';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { CATEGORY_ID, parseRoomView, type RoomView } from '@repo/game-protocol/socket';
import productRelease from '@repo/product-release';
import { v7 as uuidV7 } from 'uuid';

import { verifyBuiltWorker } from './built-roll-worker';

const packageRoot = resolve(import.meta.dir, '../..');
const distFiles = await readdir(resolve(packageRoot, 'dist'));
if (distFiles.some((file) => file.endsWith('.png'))) {
  throw new Error('Built server must not emit character image assets');
}
const mainBundle = await Bun.file(resolve(packageRoot, 'dist/main.js')).text();
if (/\/assets\/game\/character|manifest\.generated|lumi-original\.png/u.test(mainBundle)) {
  throw new Error('Built server must not bundle the browser asset manifest or character images');
}

// Keep the declared Rapier runtime dependency, but no project source, release JSON or Git checkout.
const artifactDirectory = await mkdtemp(join(tmpdir(), 'hanpan-built-server-'));
await cp(resolve(packageRoot, 'dist'), artifactDirectory, { recursive: true });
const dependencyDirectory = join(artifactDirectory, 'node_modules/@dimforge');
await mkdir(dependencyDirectory, { recursive: true });
await cp(
  dirname(
    fileURLToPath(import.meta.resolve('@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.wasm')),
  ),
  join(dependencyDirectory, 'rapier3d-deterministic'),
  { recursive: true },
);
const child = Bun.spawn([process.execPath, 'main.js'], {
  cwd: artifactDirectory,
  env: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0' },
  stderr: 'pipe',
  stdout: 'pipe',
});

const sessions: GameSession[] = [];
const unsubscriptions: Array<() => void> = [];
let failure: Error | undefined;
let exitCode: number | undefined;
let stderr = '';
try {
  const output = await readUntilUrl(child.stdout, child.exited);
  const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
  if (!match) throw new Error(`Built server did not report its URL: ${output}`);

  const health = await fetch(`${match[0]}/health`);
  const body = (await health.json()) as { ok?: boolean; runtime?: string };
  if (health.status !== 200 || body.ok !== true || body.runtime !== 'bun') {
    throw new Error(`Unexpected built health response: ${health.status} ${JSON.stringify(body)}`);
  }
  const rollActionId = uuidV7();
  let actionCount = 0;
  const client = createGameClient({
    serverUrl: match[0],
    releaseId: productRelease.version,
    createActionId: () => (actionCount++ < 2 ? rollActionId : uuidV7()),
  });
  const created = await client.createRoom({
    clientId: '01890f47-e89b-7cc3-98c5-4c5da03f78aa',
    profile: { characterId: 'navy-bob', variant: false },
  });
  assert.ok(created.ok, 'The SDK and isolated server must use the same embedded release');
  assert.equal(created.data.view.room.status, 'waiting');
  assert.equal(created.data.view.game, null);
  assert.equal(created.data.view.presence.seats.length, 1);
  const creator = client.createSession(created.data.authority);
  sessions.push(creator);
  assert.ok((await creator.connect()).ok, 'The same release must pass Socket authentication');
  assert.equal(sessionView(creator).room.status, 'waiting');
  assert.equal(sessionView(creator).game, null);
  assert.equal(sessionView(creator).presence.seats[0].status, 'connected');
  assert.ok(creator.getSnapshot().syncRevision > 0);
  assert.notEqual(client.clock.now(), null);

  const incompatible = createGameClient({ serverUrl: match[0], releaseId: 'different-release' });
  const rejected = await incompatible.joinRoom({
    clientId: '01890f47-e89b-7cc3-98c5-4c5da03f78ac',
    roomCode: created.data.view.room.roomCode,
    profile: { characterId: 'blonde-buns', variant: false },
  });
  assert.ok(!rejected.ok && rejected.error.kind === 'server');
  assert.equal(rejected.error.error.code, PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH);
  const { roomId, seatToken } = created.data.authority;
  const resumed = await client.resumeRoom({ roomId, seatToken });
  assert.ok(resumed.ok);
  assert.equal(resumed.data.view.room.status, 'waiting', 'Rejected join must not match the room');
  const staleSession = incompatible.createSession(created.data.authority);
  try {
    assert.equal((await staleSession.connect()).ok, false);
  } finally {
    staleSession.dispose();
  }

  const joined = await client.joinRoom({
    clientId: '01890f47-e89b-7cc3-98c5-4c5da03f78ab',
    roomCode: created.data.view.room.roomCode,
    profile: { characterId: 'blonde-buns', variant: false },
  });
  assert.ok(joined.ok, 'A compatible join must start the isolated match');
  assert.equal(joined.data.authority.roomId, created.data.authority.roomId);
  assert.equal(joined.data.authority.seatIndex, 1);
  assert.equal(joined.data.view.room.status, 'playing');
  const joiner = client.createSession(joined.data.authority);
  sessions.push(joiner);
  assert.ok((await joiner.connect()).ok);
  await waitFor(
    () =>
      sessions.every((session) => {
        const snapshot = session.getSnapshot();
        return (
          snapshot.game?.match.status === 'playing' &&
          snapshot.presence?.seats.every((seat) => seat.status === 'connected')
        );
      }),
    'Both SDK seats must adopt the playing view and connected presence',
  );
  for (const session of sessions) {
    const view = sessionView(session);
    assert.equal(view.room.roomId, created.data.authority.roomId);
    assert.equal(view.room.status, 'playing');
    assert.equal(view.room.seats.length, 2);
  }
  const initial = sessionView(creator).game;
  assert.ok(initial?.match.status === 'playing');
  const actor = initial.match.currentTurn.seatIndex === 0 ? creator : joiner;
  const rolled = await actor.rollDice();
  assert.ok(rolled.ok && 'roll' in rolled.data);
  assert.equal(rolled.data.stateVersion, initial.stateVersion + 1);
  await waitFor(
    () =>
      sessions.every(
        (session) => session.getSnapshot().game?.stateVersion === rolled.data.stateVersion,
      ),
    'Both SDK seats must adopt the committed roll',
  );
  const duplicate = await actor.rollDice();
  assert.ok(duplicate.ok);
  assert.deepEqual(duplicate.data, rolled.data, 'Duplicate roll must return the original receipt');
  for (const session of sessions) {
    const { game } = sessionView(session);
    assert.ok(game?.match.status === 'playing');
    assert.equal(game.stateVersion, rolled.data.stateVersion);
    assert.equal(game.match.currentTurn.rollCount, 1, 'Duplicate roll must not advance the game');
  }
  const scored = await actor.selectScoreCategory(CATEGORY_ID.ONES);
  assert.ok(scored.ok);
  assert.equal(scored.data.stateVersion, rolled.data.stateVersion + 1);
  const { syncRevision } = creator.getSnapshot();
  assert.ok((await creator.synchronize()).ok);
  assert.equal(creator.getSnapshot().syncRevision, syncRevision + 1);
  assert.equal(creator.getSnapshot().presentation?.kind, 'settled');
  await waitFor(
    () =>
      sessions.every(
        (session) => session.getSnapshot().game?.stateVersion === scored.data.stateVersion,
      ),
    'Both SDK seats must retain the score commit after full synchronization',
  );

  const observations = sessions.map((session) => {
    const observation = { finishedWhileConnected: false, disconnectedAfterFinished: false };
    unsubscriptions.push(
      session.subscribe(() => {
        const snapshot = session.getSnapshot();
        if (snapshot.game?.match.status === 'finished' && snapshot.connection === 'connected') {
          observation.finishedWhileConnected = true;
        }
        if (snapshot.connection === 'disconnected' && observation.finishedWhileConnected) {
          observation.disconnectedAfterFinished = true;
        }
      }),
    );
    return observation;
  });
  const finished = await joiner.forfeitMatch();
  assert.ok(finished.ok);
  assert.equal(finished.data.stateVersion, scored.data.stateVersion + 1);
  await waitFor(
    () => observations.every((observation) => observation.finishedWhileConnected),
    'Both SDK seats must receive the finished view before transport close',
  );
  await waitFor(
    () => observations.every((observation) => observation.disconnectedAfterFinished),
    'Production maintenance must close both finished-room transports',
    35_000,
  );
  const removed = await client.resumeRoom({ roomId, seatToken });
  assert.ok(!removed.ok && removed.error.kind === 'server');
  assert.equal(removed.error.error.code, PUBLIC_ERROR_CODE.ROOM_NOT_FOUND);
  for (const session of sessions) {
    const view = sessionView(session);
    assert.equal(view.room.status, 'finished');
    assert.equal(view.game?.match.status, 'finished');
    assert.equal(view.game?.stateVersion, finished.data.stateVersion);
  }
  console.log(
    JSON.stringify({
      builtServer: match[0],
      health: body,
      release: productRelease.version,
      isolatedArtifact: true,
      httpCompatibility: true,
      socketCompatibility: true,
      roomViewLifecycle: true,
      duplicateRollReceipt: true,
      finishedBeforeClose: true,
    }),
  );
} catch (error) {
  failure = error instanceof Error ? error : new Error('Unknown built server smoke failure');
} finally {
  unsubscriptions.forEach((unsubscribe) => unsubscribe());
  sessions.forEach((session) => session.dispose());
  try {
    child.kill('SIGTERM');
  } catch {
    // The child may have exited before the cleanup signal was sent.
  }
  try {
    exitCode = await child.exited;
  } catch {
    // Preserve the first startup or health failure if child cleanup fails.
  }
  try {
    stderr = (await new Response(child.stderr).text()).trim();
  } catch {
    // Preserve the first startup or health failure if stderr cannot be read.
  }
}

await rm(artifactDirectory, { recursive: true, force: true });

if (exitCode !== undefined && exitCode !== 0) {
  failure = failure
    ? new Error(`${failure.message}; child exited with ${exitCode}`)
    : new Error(`Built server exited with ${exitCode}`);
}
if (failure && stderr) {
  failure = new Error(`${failure.message}; stderr: ${stderr}`);
}
if (failure) throw failure;

await verifyBuiltWorker();

function sessionView(session: GameSession): RoomView {
  const { room, game, presence } = session.getSnapshot();
  return parseRoomView({ room, game, presence });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs: number = 5_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(message);
    await Bun.sleep(20);
  }
}

async function readUntilUrl(
  stream: ReadableStream<Uint8Array>,
  exited: Promise<number>,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const childExit = exited.then((code) => ({ type: 'exit' as const, code }));
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('Timed out waiting for built server output')),
        2_000,
      );
    });

    while (!/http:\/\/127\.0\.0\.1:\d+/.test(output)) {
      const result = await Promise.race([
        reader.read().then(({ done, value }) => ({ type: 'stdout' as const, done, value })),
        childExit,
        deadline,
      ]);
      if (result.type === 'exit') {
        throw new Error(`Built server exited before reporting its URL (exit code ${result.code})`);
      }
      if (result.done) break;
      output += decoder.decode(result.value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    if (timeout) clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
