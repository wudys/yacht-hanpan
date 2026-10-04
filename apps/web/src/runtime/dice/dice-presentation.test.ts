import type { GameSession, GameSessionSnapshot, RoomAuthority } from '@repo/game-client-sdk';
import { parseGameSnapshot, type ResolvedRollArtifact } from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import { createDicePresentation } from '@/runtime/dice/dice-presentation';
import type { RollPlayback } from '@/runtime/dice/replay';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';
import type {
  GameSessionHolder,
  GameSessionHolderSnapshot,
} from '@/runtime/session/session-holder';

const AUTHORITY = {
  roomId: '01991e1b-4f4f-7000-8000-000000000001',
  seatIndex: 0,
  seatToken: 'ae408a66-9755-4a30-8f8c-22ee1e911296',
} as RoomAuthority;
const SESSION_A = {} as GameSession;
const SESSION_B = {} as GameSession;
const RESOURCES = {} as ProceduralDiceResources;

function artifact(
  rollId: string,
  values: readonly (1 | 2 | 3 | 4 | 5 | 6)[],
): ResolvedRollArtifact {
  return {
    type: 'roll:resolved',
    replay: {
      mode: 'seeded-physics',
      contract: createCompatibilityContract('test'),
      rollId: rollId as ResolvedRollArtifact['replay']['rollId'],
      seed: `seed-${rollId}`,
      pourStyle: 'classic',
      rolledSlots: values.map((_, slot) => slot),
    },
    outcome: {
      authoritativeValuesBySlot: values.map((value, slot) => ({ slot, value })),
    },
  } as ResolvedRollArtifact;
}

function playingGame(
  turnId: string,
  values: readonly (1 | 2 | 3 | 4 | 5 | 6)[] | null,
  heldSlots: readonly number[] = [],
  stateVersion: number = 1,
): NonNullable<GameSessionSnapshot['game']> {
  const parsed = parseGameSnapshot({
    stateVersion,
    match: {
      status: 'playing',
      players: [
        { scorecard: {}, timeoutCount: 0 },
        { scorecard: {}, timeoutCount: 0 },
      ],
      currentTurn: {
        turnId: '11111111-1111-4111-8111-000000000001',
        seatIndex: 0,
        startedAt: 1_000,
        deadlineAt: 61_000,
        rollCount: values === null ? 0 : 1,
        heldSlots,
        dice: values === null ? null : values.map((value) => ({ value })),
      },
    },
  });
  if (parsed.match.status !== 'playing') throw new Error('Expected playing fixture');
  return {
    ...parsed,
    match: {
      ...parsed.match,
      currentTurn: {
        ...parsed.match.currentTurn,
        turnId: turnId as typeof parsed.match.currentTurn.turnId,
      },
    },
  };
}

function finishedGame(): NonNullable<GameSessionSnapshot['game']> {
  return parseGameSnapshot({
    stateVersion: 10,
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

function createHolder(
  game: NonNullable<GameSessionSnapshot['game']>,
  roll: ResolvedRollArtifact | null = null,
) {
  let snapshot = activeSnapshot(SESSION_A, game, roll);
  const listeners = new Set<() => void>();
  const sessions = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as GameSessionHolder;
  return {
    sessions,
    publish(next: {
      game?: NonNullable<GameSessionSnapshot['game']>;
      roll?: ResolvedRollArtifact | null;
      session?: GameSession;
      authority?: RoomAuthority;
      connection?: GameSessionSnapshot['connection'];
      presentation?: GameSessionSnapshot['presentation'];
      syncRevision?: number;
    }) {
      const game = next.game ?? snapshot.sessionSnapshot.game!;
      const previous = snapshot.sessionSnapshot;
      snapshot = activeSnapshot(
        next.session ?? snapshot.session,
        game,
        next.roll ?? null,
        next.authority ?? snapshot.authority,
      );
      snapshot = {
        ...snapshot,
        sessionSnapshot: {
          ...snapshot.sessionSnapshot,
          presentation:
            next.presentation !== undefined
              ? next.presentation
              : next.roll !== undefined || next.game !== undefined
                ? snapshot.sessionSnapshot.presentation
                : previous.presentation,
          syncRevision: next.syncRevision ?? previous.syncRevision,
          connection: next.connection ?? previous.connection,
        },
      };
      listeners.forEach((listener) => listener());
    },
  };
}

function activeSnapshot(
  session: GameSession,
  game: NonNullable<GameSessionSnapshot['game']>,
  roll: ResolvedRollArtifact | null,
  authority: RoomAuthority = AUTHORITY,
): Extract<GameSessionHolderSnapshot, { authority: RoomAuthority }> {
  return {
    authority,
    room: null,
    session,
    sessionSnapshot: {
      room: null,
      connection: 'connected',
      syncStatus: 'idle',
      syncRevision: 1,
      game,
      presence: null,
      presentation:
        roll && game.match.status === 'playing'
          ? {
              kind: 'roll',
              roll,
            }
          : { kind: 'settled' },
      error: null,
    },
  };
}

function verifiedPlayback(rollId: string): RollPlayback {
  return {
    status: 'verified',
    rollId,
    timeline: { rollId },
  } as RollPlayback;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DicePresentation', () => {
  test.each([
    { state: 'before the first roll', game: playingGame('turn-a', null) },
    { state: 'settled dice', game: playingGame('turn-a', [1, 2, 3, 4, 5]) },
    { state: 'finished game', game: finishedGame() },
  ])('keeps the visual snapshot during connection changes with $state', ({ game }) => {
    const { sessions, publish } = createHolder(game);
    const presentation = createDicePresentation({
      sessions,
      playCue: vi.fn(),
      requestSynchronization: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
    });
    presentation.start();
    presentation.setResources(RESOURCES);
    const snapshot = presentation.getSnapshot();
    const listener = vi.fn();
    presentation.subscribe(listener);

    publish({ connection: 'disconnected' });
    publish({ connection: 'connected' });

    expect(presentation.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    presentation.dispose();
  });

  test('publishes changes to resources, visible slots, faces and phase', () => {
    const { sessions, publish } = createHolder(playingGame('turn-a', [1, 2, 3, 4, 5]));
    const presentation = createDicePresentation({
      sessions,
      playCue: vi.fn(),
      requestSynchronization: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
    });
    presentation.start();
    const listener = vi.fn();
    presentation.subscribe(listener);

    presentation.setResources(RESOURCES);
    expect(presentation.getSnapshot().resources).toBe(RESOURCES);
    publish({ game: playingGame('turn-a', [1, 2, 3, 4, 5], [0]) });
    expect(presentation.getSnapshot()).toMatchObject({
      phase: 'settled',
      dice: [
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });
    publish({ game: playingGame('turn-a', [1, 2, 3, 4, 5], [1]) });
    expect(presentation.getSnapshot()).toMatchObject({
      dice: [
        { slot: 0, value: 1 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });
    publish({ game: playingGame('turn-a', [6, 2, 3, 4, 5], [1]) });
    expect(presentation.getSnapshot()).toMatchObject({
      dice: [
        { slot: 0, value: 6 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });
    publish({ game: finishedGame() });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'hidden' });
    expect(listener).toHaveBeenCalledTimes(5);
    presentation.dispose();
  });

  test('keeps old faces while resolving and reveals the new row before achievement', async () => {
    vi.useFakeTimers();
    const { sessions, publish } = createHolder(playingGame('turn-a', [1, 2, 3, 4, 5]));
    const playCue = vi.fn();
    const presentation = createDicePresentation({
      sessions,
      playCue,
      requestSynchronization: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
      loadResolver: async () => async (roll) => verifiedPlayback(roll.replay.rollId),
    });
    await presentation.prepare();
    presentation.start();
    publish({
      game: playingGame('turn-a', [6, 6, 6, 6, 6], [], 2),
      roll: artifact('new-faces', [6, 6, 6, 6, 6]),
    });
    expect(presentation.getSnapshot()).toMatchObject({
      phase: 'resolving',
      dice: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });
    await flushPromises();
    const rolling = presentation.getSnapshot();
    if (rolling.phase !== 'rolling') throw new Error('Expected verified rolling');
    presentation.completePlayback('new-faces');
    expect(presentation.getSnapshot()).toMatchObject({
      phase: 'revealing',
      playback: rolling.playback,
    });
    expect(playCue).not.toHaveBeenCalled();
    publish({ connection: 'connected' });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'revealing' });
    vi.advanceTimersByTime(359);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'revealing' });
    vi.advanceTimersByTime(1);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'achievement' });
    expect(playCue).toHaveBeenCalledTimes(1);
    publish({
      game: playingGame('turn-a', [6, 6, 6, 6, 6], [], 3),
      roll: artifact('interrupted-reveal', [6, 6, 6, 6, 6]),
    });
    await flushPromises();
    presentation.completePlayback('interrupted-reveal');
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'revealing' });
    publish({ game: finishedGame() });
    vi.advanceTimersByTime(2_500);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'hidden' });
    expect(playCue).toHaveBeenCalledTimes(1);
    presentation.dispose();
  });
  test('retries replay preparation, suppresses history, and sequences a new Yacht once', async () => {
    vi.useFakeTimers();
    const oldRoll = artifact('roll-old', [1, 2, 3, 4, 5]);
    const newRoll = artifact('roll-new', [6, 6, 6, 6, 6]);
    const { sessions, publish } = createHolder(playingGame('turn-a', [1, 2, 3, 4, 5]), oldRoll);
    const resolver = vi.fn(async (input: ResolvedRollArtifact) =>
      verifiedPlayback(input.replay.rollId),
    );
    const loadResolver = vi.fn(async () => resolver);
    loadResolver.mockRejectedValueOnce(new Error('replay code unavailable'));
    const playCue = vi.fn();
    const presentation = createDicePresentation({
      sessions,
      loadResolver,
      playCue,
      requireRefreshAfterSynchronization: vi.fn(),
      requestSynchronization: vi.fn(),
    });

    await expect(presentation.prepare()).rejects.toThrow('replay code unavailable');
    await presentation.prepare();
    presentation.setResources(RESOURCES);
    presentation.start();
    expect(loadResolver).toHaveBeenCalledTimes(2);
    expect(resolver).not.toHaveBeenCalled();
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });

    publish({ game: playingGame('turn-a', [6, 6, 6, 6, 6], [1], 2), roll: newRoll });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'resolving', rollId: 'roll-new' });
    await flushPromises();
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling', rollId: 'roll-new' });

    presentation.completePlayback('roll-new');
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'revealing' });
    vi.advanceTimersByTime(360);
    expect(presentation.getSnapshot()).toMatchObject({
      phase: 'achievement',
      achievement: { kind: 'yacht', categoryId: 'yacht' },
      dice: [
        { slot: 0, value: 6 },
        { slot: 2, value: 6 },
        { slot: 3, value: 6 },
        { slot: 4, value: 6 },
      ],
    });
    expect(playCue).toHaveBeenCalledTimes(1);
    expect(playCue).toHaveBeenCalledWith(PRODUCT_CUE.ACHIEVEMENT_YACHT);

    vi.advanceTimersByTime(1_980);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
    publish({ game: playingGame('turn-a', [6, 6, 6, 6, 6], [1], 2) });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(playCue).toHaveBeenCalledTimes(1);
  });

  test('keeps authoritative fallback locked for refresh and never replays it after replacement', async () => {
    const roll = artifact('roll-fallback', [2, 2, 2, 3, 5]);
    const { sessions, publish } = createHolder(playingGame('turn-a', null));
    const fallback: RollPlayback = {
      status: 'static-fallback',
      rollId: 'roll-fallback',
      reason: 'OUTCOME_MISMATCH',
      dice: [],
    };
    const resolver = vi.fn(async (input: ResolvedRollArtifact) => ({
      ...fallback,
      rollId: input.replay.rollId,
    }));
    const requestSynchronization = vi.fn();
    const requireRefreshAfterSynchronization = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const presentation = createDicePresentation({
      sessions,
      loadResolver: async () => resolver,
      playCue: vi.fn(),
      requireRefreshAfterSynchronization,
      requestSynchronization,
    });
    await presentation.prepare();
    presentation.start();

    publish({ game: playingGame('turn-a', [2, 2, 2, 3, 5], [], 2), roll });
    await flushPromises();
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling', playback: fallback });
    expect(requireRefreshAfterSynchronization).toHaveBeenCalledTimes(1);
    expect(requestSynchronization).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('dice_replay_static_fallback', 'OUTCOME_MISMATCH');
    expect(requireRefreshAfterSynchronization).toHaveBeenCalledWith('OUTCOME_MISMATCH');
    presentation.completePlayback('roll-fallback');
    publish({ connection: 'connected' });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling', playback: fallback });

    publish({ session: SESSION_B });
    publish({ game: playingGame('turn-a', [2, 2, 2, 3, 5], [], 2), roll });
    await flushPromises();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(requireRefreshAfterSynchronization).toHaveBeenCalledTimes(1);
    expect(requestSynchronization).not.toHaveBeenCalled();

    const replacementAuthority = {
      ...AUTHORITY,
      roomId: '01991e1b-4f4f-7000-8000-000000000002',
    } as RoomAuthority;
    publish({
      authority: replacementAuthority,
      session: SESSION_A,
      game: playingGame('turn-a', [1, 2, 3, 4, 5]),
      roll: artifact('roll-new-room-history', [1, 2, 3, 4, 5]),
    });
    await flushPromises();
    expect(resolver).toHaveBeenCalledTimes(1);

    publish({
      game: playingGame('turn-a', [2, 2, 2, 3, 5], [], 2),
      roll: artifact('roll-new-room-live', [2, 2, 2, 3, 5]),
    });
    await flushPromises();
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test('leaves achievement immediately when the authoritative turn advances', async () => {
    vi.useFakeTimers();
    const roll = artifact('roll-achievement', [4, 4, 4, 4, 2]);
    const { sessions, publish } = createHolder(playingGame('turn-a', null));
    const presentation = createDicePresentation({
      sessions,
      loadResolver: async () => async () => verifiedPlayback('roll-achievement'),
      playCue: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
      requestSynchronization: vi.fn(),
    });
    await presentation.prepare();
    presentation.start();

    publish({ game: playingGame('turn-a', [4, 4, 4, 4, 2], [], 2), roll });
    await flushPromises();
    presentation.completePlayback('roll-achievement');
    vi.advanceTimersByTime(360);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'achievement' });

    publish({ game: playingGame('turn-b', [1, 2, 3, 4, 5], [], 3) });
    expect(presentation.getSnapshot()).toMatchObject({
      phase: 'settled',
      dice: [
        { slot: 0, value: 1 },
        { slot: 1, value: 2 },
        { slot: 2, value: 3 },
        { slot: 3, value: 4 },
        { slot: 4, value: 5 },
      ],
    });

    vi.advanceTimersByTime(2_000);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
    presentation.dispose();
  });

  test('settles immediately when a newer non-roll state supersedes an active roll', async () => {
    const roll = artifact('roll-stale', [1, 1, 1, 1, 1]);
    const { sessions, publish } = createHolder(playingGame('turn-a', null));
    const presentation = createDicePresentation({
      sessions,
      loadResolver: async () => async () => verifiedPlayback('roll-stale'),
      playCue: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
      requestSynchronization: vi.fn(),
    });
    await presentation.prepare();
    presentation.start();

    publish({ game: playingGame('turn-a', [1, 1, 1, 1, 1], [], 2), roll });
    await flushPromises();
    publish({ game: playingGame('turn-a', [1, 2, 3, 4, 6], [], 3) });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
    presentation.completePlayback('roll-stale');

    expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
  });

  test('cancels stale resolution, active rolls, and achievement timers on authority advance', async () => {
    vi.useFakeTimers();
    const first = artifact('roll-first', [4, 4, 4, 4, 2]);
    let resolveFirst: (playback: RollPlayback) => void = () => {
      throw new Error('Expected the first resolver to be pending');
    };
    const resolver = vi.fn(
      (input: ResolvedRollArtifact) =>
        new Promise<RollPlayback>((resolve) => {
          if (input.replay.rollId === 'roll-first') resolveFirst = resolve;
          else resolve(verifiedPlayback(input.replay.rollId));
        }),
    );
    const { sessions, publish } = createHolder(playingGame('turn-a', null));
    const playCue = vi.fn();
    const presentation = createDicePresentation({
      sessions,
      loadResolver: async () => resolver,
      playCue,
      requireRefreshAfterSynchronization: vi.fn(),
      requestSynchronization: vi.fn(),
    });
    await presentation.prepare();
    presentation.start();

    publish({ game: playingGame('turn-a', [4, 4, 4, 4, 2], [], 2), roll: first });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'resolving' });
    await flushPromises();
    publish({ session: SESSION_B });
    resolveFirst(verifiedPlayback('roll-first'));
    await flushPromises();
    expect(presentation.getSnapshot()).not.toMatchObject({ phase: 'rolling' });

    const second = artifact('roll-second', [4, 4, 4, 4, 2]);
    publish({ game: playingGame('turn-a', [4, 4, 4, 4, 2], [], 3), roll: second });
    await flushPromises();
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling' });
    publish({ game: playingGame('turn-b', [4, 4, 4, 4, 2], [], 4) });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });

    const third = artifact('roll-third', [4, 4, 4, 4, 2]);
    publish({ game: playingGame('turn-b', [4, 4, 4, 4, 2], [], 5), roll: third });
    await flushPromises();
    presentation.completePlayback('roll-third');
    vi.advanceTimersByTime(360);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'achievement' });
    expect(playCue).toHaveBeenCalledWith(PRODUCT_CUE.ACHIEVEMENT_OTHER);

    publish({ game: finishedGame() });
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'hidden' });
    vi.advanceTimersByTime(2_000);
    expect(presentation.getSnapshot()).toMatchObject({ phase: 'hidden' });
    presentation.dispose();
  });
});

test('settles immediately after full synchronization during reveal and ignores stale completion', async () => {
  vi.useFakeTimers();
  const { sessions, publish } = createHolder(playingGame('turn-a', [1, 2, 3, 4, 5]));
  const playCue = vi.fn();
  const presentation = createDicePresentation({
    sessions,
    playCue,
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver: async () => async (roll) => verifiedPlayback(roll.replay.rollId),
  });
  await presentation.prepare();
  presentation.start();
  publish({
    game: playingGame('turn-a', [6, 6, 6, 6, 6], [], 2),
    roll: artifact('before-recovery', [6, 6, 6, 6, 6]),
  });
  await flushPromises();
  presentation.completePlayback('before-recovery');
  const current = sessions.getSnapshot();
  if (current.authority === null) throw new Error('Expected active fixture');
  publish({
    syncRevision: current.sessionSnapshot.syncRevision + 1,
    presentation: { kind: 'settled' },
  });
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
  presentation.completePlayback('before-recovery');
  vi.advanceTimersByTime(360);
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
  expect(playCue).not.toHaveBeenCalled();
  presentation.dispose();
});

test.each(['resolve', 'reject'] as const)(
  'a restored view cancels pending resolution and ignores its late %s',
  async (completion) => {
    const values = [6, 6, 6, 6, 6] as const;
    const { sessions, publish } = createHolder(playingGame('turn-a', null));
    let resolvePending!: (playback: RollPlayback) => void;
    let rejectPending!: (error: Error) => void;
    const requestSynchronization = vi.fn();
    const requireRefreshAfterSynchronization = vi.fn();
    const playCue = vi.fn();
    const onUnexpected = vi.fn();
    const presentation = createDicePresentation({
      sessions,
      playCue,
      onUnexpected,
      requestSynchronization,
      requireRefreshAfterSynchronization,
      loadResolver: async () => () =>
        new Promise((resolve, reject) => {
          resolvePending = resolve;
          rejectPending = reject;
        }),
    });
    await presentation.prepare();
    presentation.start();
    publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('restored', values) });
    await flushPromises();
    expect(presentation.getSnapshot().phase).toBe('resolving');
    publish({ presentation: { kind: 'settled' }, syncRevision: 2 });
    expect(presentation.getSnapshot()).toMatchObject({
      phase: 'settled',
      dice: values.map((value, slot) => ({ slot, value })),
    });
    if (completion === 'resolve') resolvePending(verifiedPlayback('restored'));
    else rejectPending(new Error('stale resolution failed'));
    await flushPromises();
    expect(presentation.getSnapshot().phase).toBe('settled');
    expect(requestSynchronization).not.toHaveBeenCalled();
    expect(requireRefreshAfterSynchronization).not.toHaveBeenCalled();
    expect(playCue).not.toHaveBeenCalled();
    expect(onUnexpected).not.toHaveBeenCalled();
    presentation.dispose();
  },
);

test.each([
  'restoration',
  'session replacement',
  'turn advancement',
  'match completion',
  'disposal',
] as const)(
  '%s during achievement cancels its timer and ignores already queued callbacks',
  async (change) => {
    const values = [6, 6, 6, 6, 6] as const;
    const { sessions, publish } = createHolder(playingGame('turn-a', null));
    const callbacks: (() => void)[] = [];
    const cancelTimer = vi.fn();
    const playCue = vi.fn();
    const presentation = createDicePresentation({
      sessions,
      playCue,
      requestSynchronization: vi.fn(),
      requireRefreshAfterSynchronization: vi.fn(),
      loadResolver: async () => async (roll) => verifiedPlayback(roll.replay.rollId),
      setTimeout: (callback) => callbacks.push(callback),
      clearTimeout: cancelTimer,
    });
    await presentation.prepare();
    presentation.start();
    publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('achievement', values) });
    await flushPromises();
    presentation.completePlayback('achievement');
    callbacks[0]!();
    expect(presentation.getSnapshot().phase).toBe('achievement');
    const settledValues = [1, 2, 3, 4, 5] as const;
    const settledGame = playingGame('turn-a', settledValues, [], 4);
    switch (change) {
      case 'restoration':
        publish({ game: settledGame, syncRevision: 2 });
        break;
      case 'session replacement':
        publish({ game: settledGame, session: SESSION_B });
        break;
      case 'turn advancement':
        publish({ game: playingGame('turn-b', settledValues, [], 4) });
        break;
      case 'match completion':
        publish({ game: finishedGame() });
        break;
      case 'disposal':
        presentation.dispose();
        break;
    }
    const cancelled = presentation.getSnapshot();
    expect(cancelled).toMatchObject(
      change === 'match completion' || change === 'disposal'
        ? { phase: 'hidden' }
        : {
            phase: 'settled',
            dice: settledValues.map((value, slot) => ({ slot, value })),
          },
    );
    expect(cancelTimer).toHaveBeenCalledWith(2);
    callbacks[0]!();
    callbacks[1]!();
    presentation.completePlayback('achievement');
    expect(presentation.getSnapshot()).toBe(cancelled);
    expect(playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.ACHIEVEMENT_YACHT);
    presentation.dispose();
  },
);

test('old full-sync confirmation preserves a fresh roll through resolution, reveal and achievement', async () => {
  vi.useFakeTimers();
  const values = [6, 6, 6, 6, 6] as const;
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  let resolvePending!: (playback: RollPlayback) => void;
  const playCue = vi.fn();
  const presentation = createDicePresentation({
    sessions,
    playCue,
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver: async () => () =>
      new Promise((resolve) => {
        resolvePending = resolve;
      }),
  });
  await presentation.prepare();
  presentation.start();
  publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('fresh', values) });
  await flushPromises();
  const resolving = presentation.getSnapshot();
  publish({ syncRevision: 2 });
  expect(presentation.getSnapshot()).toBe(resolving);
  resolvePending(verifiedPlayback('fresh'));
  await flushPromises();
  presentation.completePlayback('fresh');
  const revealing = presentation.getSnapshot();
  publish({ syncRevision: 3 });
  expect(presentation.getSnapshot()).toBe(revealing);
  vi.advanceTimersByTime(360);
  const achievement = presentation.getSnapshot();
  expect(achievement.phase).toBe('achievement');
  publish({ syncRevision: 4 });
  expect(presentation.getSnapshot()).toBe(achievement);
  expect(playCue).toHaveBeenCalledExactlyOnceWith(PRODUCT_CUE.ACHIEVEMENT_YACHT);
  vi.advanceTimersByTime(1_980);
  expect(presentation.getSnapshot().phase).toBe('settled');
  presentation.dispose();
});

test('late timers and completion from an older roll cannot finish its replacement', async () => {
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  const timers: (() => void)[] = [];
  const cancelTimer = vi.fn();
  const playCue = vi.fn();
  const presentation = createDicePresentation({
    sessions,
    playCue,
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver: async () => async (roll) => verifiedPlayback(roll.replay.rollId),
    setTimeout: (callback) => timers.push(callback),
    clearTimeout: cancelTimer,
  });
  await presentation.prepare();
  presentation.start();
  const values = [6, 6, 6, 6, 6] as const;
  publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('first', values) });
  await flushPromises();
  presentation.completePlayback('first');
  timers[0]!();
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'achievement', rollId: 'first' });
  expect(playCue).toHaveBeenCalledTimes(1);

  publish({ game: playingGame('turn-a', values, [], 3), roll: artifact('replacement', values) });
  await flushPromises();
  expect(cancelTimer).toHaveBeenCalledWith(2);
  timers[0]!();
  timers[1]!();
  presentation.completePlayback('first');
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling', rollId: 'replacement' });
  expect(playCue).toHaveBeenCalledTimes(1);
  presentation.completePlayback('replacement');
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'revealing', rollId: 'replacement' });
  presentation.dispose();
  expect(cancelTimer).toHaveBeenCalledWith(3);
  timers[2]!();
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'hidden' });
  expect(playCue).toHaveBeenCalledTimes(1);
});

test('a replaced roll resolver rejection cannot cancel the current roll or request sync', async () => {
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  let rejectFirst!: (error: Error) => void;
  const requestSynchronization = vi.fn();
  const onUnexpected = vi.fn();
  const presentation = createDicePresentation({
    sessions,
    playCue: vi.fn(),
    requestSynchronization,
    onUnexpected,
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver: async () => (roll) =>
      roll.replay.rollId === 'first'
        ? new Promise((_resolve, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve(verifiedPlayback(roll.replay.rollId)),
  });
  await presentation.prepare();
  presentation.start();
  const values = [1, 2, 3, 4, 5] as const;
  publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('first', values) });
  await flushPromises();
  publish({ game: playingGame('turn-a', values, [], 3), roll: artifact('replacement', values) });
  await flushPromises();
  rejectFirst(new Error('old resolver failed'));
  await flushPromises();
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling', rollId: 'replacement' });
  expect(requestSynchronization).not.toHaveBeenCalled();
  expect(onUnexpected).not.toHaveBeenCalled();
  presentation.dispose();
});

test('reports an active resolver rejection once and settles while requesting synchronization', async () => {
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  const cause = new TypeError('resolver invariant');
  const onUnexpected = vi.fn();
  const requestSynchronization = vi.fn();
  const presentation = createDicePresentation({
    sessions,
    onUnexpected,
    playCue: vi.fn(),
    requestSynchronization,
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver: async () => () => Promise.reject(cause),
  });
  await presentation.prepare();
  presentation.start();
  const values = [1, 2, 3, 4, 5] as const;
  publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('failed', values) });
  await flushPromises();
  expect(onUnexpected).toHaveBeenCalledExactlyOnceWith(cause);
  expect(requestSynchronization).toHaveBeenCalledOnce();
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'settled' });
  presentation.dispose();
});

test('passes the original simulation fallback cause once to the refresh owner', async () => {
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  const cause = new WebAssembly.RuntimeError('simulation trapped');
  const requireRefreshAfterSynchronization = vi.fn();
  const onUnexpected = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const presentation = createDicePresentation({
    sessions,
    onUnexpected,
    playCue: vi.fn(),
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization,
    loadResolver: async () => async (roll) => ({
      status: 'static-fallback',
      rollId: roll.replay.rollId,
      reason: 'SIMULATION_FAILED',
      cause,
      dice: [],
    }),
  });
  await presentation.prepare();
  presentation.start();
  const values = [1, 2, 3, 4, 5] as const;
  publish({ game: playingGame('turn-a', values, [], 2), roll: artifact('failed', values) });
  await flushPromises();
  expect(requireRefreshAfterSynchronization).toHaveBeenCalledExactlyOnceWith(
    'SIMULATION_FAILED',
    cause,
  );
  expect(onUnexpected).not.toHaveBeenCalled();
  presentation.dispose();
});

test('does not start replay after disposal before its scheduled resolution', async () => {
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  const resolver = vi.fn(async (roll: ResolvedRollArtifact) =>
    verifiedPlayback(roll.replay.rollId),
  );
  const presentation = createDicePresentation({
    sessions,
    playCue: vi.fn(),
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver: async () => resolver,
  });
  await presentation.prepare();
  presentation.start();

  publish({
    game: playingGame('turn-a', [1, 2, 3, 4, 5], [], 2),
    roll: artifact('cancelled', [1, 2, 3, 4, 5]),
  });
  presentation.dispose();
  await flushPromises();

  expect(resolver).not.toHaveBeenCalled();
  expect(presentation.getSnapshot().phase).toBe('hidden');
});

test('skips a roll cancelled during resolver loading and resolves the next live roll', async () => {
  const { sessions, publish } = createHolder(playingGame('turn-a', null));
  const resolver = vi.fn(async (roll: ResolvedRollArtifact) =>
    verifiedPlayback(roll.replay.rollId),
  );
  let finishLoading!: (loaded: typeof resolver) => void;
  const loadResolver = vi.fn(
    () =>
      new Promise<typeof resolver>((resolve) => {
        finishLoading = resolve;
      }),
  );
  const presentation = createDicePresentation({
    sessions,
    playCue: vi.fn(),
    requestSynchronization: vi.fn(),
    requireRefreshAfterSynchronization: vi.fn(),
    loadResolver,
  });
  presentation.start();
  publish({
    game: playingGame('turn-a', [1, 2, 3, 4, 5], [], 2),
    roll: artifact('cancelled', [1, 2, 3, 4, 5]),
  });

  publish({ game: playingGame('turn-b', null, [], 3) });
  finishLoading(resolver);
  await flushPromises();

  expect(resolver).not.toHaveBeenCalled();
  expect(presentation.getSnapshot().phase).toBe('hidden');

  const liveRoll = artifact('live', [2, 2, 3, 4, 5]);
  publish({ game: playingGame('turn-b', [2, 2, 3, 4, 5], [], 4), roll: liveRoll });
  await flushPromises();
  expect(resolver).toHaveBeenCalledExactlyOnceWith(liveRoll);
  expect(loadResolver).toHaveBeenCalledTimes(1);
  expect(presentation.getSnapshot()).toMatchObject({ phase: 'rolling', rollId: 'live' });
  presentation.dispose();
});
