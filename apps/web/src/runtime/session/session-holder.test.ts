import type { GameSession, GameSessionSnapshot, RoomAuthority } from '@repo/game-client-sdk';
import { parsePublicRoom, type PublicRoom } from '@repo/game-protocol/socket';
import { describe, expect, test, vi } from 'vitest';

import { createGameSessionHolder } from '@/runtime/session/session-holder';
import { finishedGame } from '@/testing/game-fixtures';

// This lifecycle test supplies syntactically valid authority values already validated by the SDK.
const ROOM_ID = '019cc3cb-b67c-7000-8000-000000000001' as RoomAuthority['roomId'];
const FIRST_SEAT_TOKEN = '019cc3cb-b67c-4000-8000-000000000002' as RoomAuthority['seatToken'];
const SECOND_SEAT_TOKEN = '019cc3cb-b67c-4000-8000-000000000003' as RoomAuthority['seatToken'];
const OTHER_ROOM_ID = '019cc3cb-b67c-7000-8000-000000000004' as RoomAuthority['roomId'];
const authority: RoomAuthority = {
  roomId: ROOM_ID,
  seatIndex: 0,
  seatToken: FIRST_SEAT_TOKEN,
};

const creatorSeat = { profile: { characterId: 'navy-bob', variant: false } } as const;
const opponentSeat = { profile: { characterId: 'blonde-buns', variant: true } } as const;

function waitingRoom(roomId: RoomAuthority['roomId'] = ROOM_ID): PublicRoom {
  return parsePublicRoom({
    status: 'waiting',
    roomId,
    roomCode: '001204',
    createdAt: 1_000,
    expiresAt: 301_000,
    seats: [creatorSeat],
  });
}

function playingRoom(): PublicRoom {
  return parsePublicRoom({
    status: 'playing',
    roomId: ROOM_ID,
    roomCode: '001204',
    createdAt: 1_000,
    startedAt: 2_000,
    seats: [creatorSeat, opponentSeat],
  });
}

function finishedRoom(): PublicRoom {
  return parsePublicRoom({
    status: 'finished',
    roomId: ROOM_ID,
    roomCode: '001204',
    createdAt: 1_000,
    startedAt: 2_000,
    finishedAt: 3_000,
    seats: [creatorSeat, opponentSeat],
  });
}

function sessionSnapshot(connection: GameSessionSnapshot['connection']): GameSessionSnapshot {
  return {
    connection,
    syncStatus: 'idle',
    syncRevision: 0,
    room: null,
    game: null,
    presence: null,
    presentation: null,
    error: null,
  };
}

function createSessionFixture(initial: GameSessionSnapshot = sessionSnapshot('idle')) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const subscribedListeners: (() => void)[] = [];
  const connect = vi.fn(async () => ({ ok: true as const }));
  const dispose = vi.fn();
  const unusedCommand = vi.fn(async () => {
    throw new Error('unused command');
  });
  const session: GameSession = {
    connect,
    disconnect: vi.fn(),
    dispose,
    synchronize: vi.fn(async () => ({ ok: true as const })),
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      subscribedListeners.push(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    rollDice: unusedCommand,
    setDieHeld: unusedCommand,
    selectScoreCategory: unusedCommand,
    forfeitMatch: unusedCommand,
  };
  return {
    activeSubscriberCount: () => listeners.size,
    connect,
    dispose,
    emit(next: GameSessionSnapshot) {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    emitDetached(next: GameSessionSnapshot) {
      snapshot = next;
      for (const listener of subscribedListeners) listener();
    },
    session,
  };
}

describe('createGameSessionHolder', () => {
  test('captures the latest finished state even before the holder subscription receives it', () => {
    const fixture = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    fixture.session.subscribe(() => holder.detachFinishedSession(fixture.session));
    holder.installAuthority(authority);
    const final = {
      ...sessionSnapshot('connected'),
      room: finishedRoom(),
      game: finishedGame('connectionEnded', 0),
    };
    fixture.emit(final);
    expect(holder.getSnapshot().sessionSnapshot).toBe(final);
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  test('detaches a finished session once and preserves its final view until clear', () => {
    const fixture = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    holder.installAuthority(authority);
    expect(holder.detachFinishedSession(fixture.session)).toBe(false);
    expect(fixture.dispose).not.toHaveBeenCalled();
    const final = {
      ...sessionSnapshot('connected'),
      room: finishedRoom(),
      game: finishedGame('explicitForfeit', 1),
    };
    fixture.emit(final);

    expect(holder.detachFinishedSession(fixture.session)).toBe(true);
    const retained = holder.getSnapshot();
    expect(retained.sessionSnapshot).toBe(final);
    expect(retained.room).toBe(final.room);
    expect(fixture.activeSubscriberCount()).toBe(0);
    expect(fixture.dispose).toHaveBeenCalledOnce();
    const notify = vi.fn();
    holder.subscribe(notify);
    expect(holder.detachFinishedSession(fixture.session)).toBe(true);
    fixture.emitDetached(sessionSnapshot('disconnected'));
    expect(holder.getSnapshot()).toBe(retained);
    expect(notify).not.toHaveBeenCalled();
    holder.clear();
    expect(holder.getSnapshot().sessionSnapshot).toBeNull();
    expect(notify).toHaveBeenCalledOnce();
    holder.clear();
    expect(notify).toHaveBeenCalledOnce();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  test('reinstalls equal authority after terminal detach and rejects the old identity', () => {
    const first = createSessionFixture({
      ...sessionSnapshot('connected'),
      room: finishedRoom(),
      game: finishedGame('explicitForfeit', 1),
    });
    const second = createSessionFixture();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(first.session)
      .mockReturnValueOnce(second.session);
    const holder = createGameSessionHolder({ createSession });
    holder.installAuthority(authority);
    holder.detachFinishedSession(first.session);

    expect(holder.installAuthority({ ...authority })).toBe(second.session);
    const replacement = holder.getSnapshot();
    expect(holder.detachFinishedSession(first.session)).toBe(false);
    first.emitDetached(sessionSnapshot('disconnected'));
    expect(holder.getSnapshot()).toBe(replacement);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
  });

  test('takes synchronized public room metadata and ignores late bootstrap metadata', () => {
    const fixture = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    holder.installAuthority(authority);
    holder.setRoom(waitingRoom());
    const room = playingRoom();
    fixture.emit({ ...sessionSnapshot('connected'), room });
    const synchronized = holder.getSnapshot();
    expect(synchronized.room).toBe(room);
    holder.setRoom(waitingRoom());
    holder.setRoom(playingRoom());
    expect(holder.getSnapshot()).toBe(synchronized);
    const finished = finishedRoom();
    fixture.emit({ ...sessionSnapshot('connected'), room: finished });
    expect(holder.getSnapshot().room).toBe(finished);
    holder.dispose();
  });

  test('uses already synchronized metadata when installing a session', () => {
    const room = playingRoom();
    const fixture = createSessionFixture({ ...sessionSnapshot('connected'), room });
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    holder.installAuthority(authority);
    expect(holder.getSnapshot().room).toBe(room);
    holder.dispose();
  });

  test('reuses one session for equal authority without connecting implicitly', () => {
    const fixture = createSessionFixture();
    const createSession = vi.fn(() => fixture.session);
    const holder = createGameSessionHolder({ createSession });
    const notify = vi.fn();
    holder.subscribe(notify);

    const first = holder.installAuthority(authority);
    const installedView = holder.getSnapshot();
    const second = holder.installAuthority({ ...authority });

    expect(first).toBe(fixture.session);
    expect(second).toBe(first);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(fixture.connect).not.toHaveBeenCalled();
    expect(holder.getSnapshot()).toBe(installedView);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(holder.getSnapshot()).toEqual({
      authority,
      room: null,
      session: fixture.session,
      sessionSnapshot: fixture.session.getSnapshot(),
    });
  });

  test('replaces changed authority and ignores callbacks from the detached session', () => {
    const firstFixture = createSessionFixture();
    const secondFixture = createSessionFixture();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(firstFixture.session)
      .mockReturnValueOnce(secondFixture.session);
    const holder = createGameSessionHolder({ createSession });
    const notify = vi.fn();
    holder.subscribe(notify);

    holder.installAuthority(authority);
    const connected = sessionSnapshot('connected');
    firstFixture.emit(connected);

    expect(holder.getSnapshot().sessionSnapshot).toBe(connected);
    expect(notify).toHaveBeenCalledTimes(2);
    holder.setRoom(waitingRoom());

    const changedAuthority: RoomAuthority = { ...authority, seatToken: SECOND_SEAT_TOKEN };
    holder.installAuthority(changedAuthority);
    const replacementView = holder.getSnapshot();

    expect(firstFixture.activeSubscriberCount()).toBe(0);
    expect(firstFixture.dispose).toHaveBeenCalledTimes(1);
    expect(replacementView).toEqual({
      authority: changedAuthority,
      room: null,
      session: secondFixture.session,
      sessionSnapshot: secondFixture.session.getSnapshot(),
    });
    expect(notify).toHaveBeenCalledTimes(4);

    firstFixture.emitDetached(sessionSnapshot('disconnected'));
    expect(holder.getSnapshot()).toBe(replacementView);
    expect(notify).toHaveBeenCalledTimes(4);

    const replacementConnected = sessionSnapshot('connected');
    secondFixture.emit(replacementConnected);
    expect(holder.getSnapshot().sessionSnapshot).toBe(replacementConnected);
    expect(notify).toHaveBeenCalledTimes(5);
  });

  test('clear is reusable while root disposal is terminal', () => {
    const firstFixture = createSessionFixture();
    const secondFixture = createSessionFixture();
    const createSession = vi
      .fn()
      .mockReturnValueOnce(firstFixture.session)
      .mockReturnValueOnce(secondFixture.session);
    const holder = createGameSessionHolder({ createSession });
    const notify = vi.fn();
    holder.subscribe(notify);

    holder.installAuthority(authority);
    holder.setRoom(waitingRoom());
    holder.clear();
    const clearedView = holder.getSnapshot();

    expect(clearedView).toEqual({
      authority: null,
      room: null,
      session: null,
      sessionSnapshot: null,
    });
    expect(firstFixture.activeSubscriberCount()).toBe(0);
    expect(firstFixture.dispose).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(3);

    holder.clear();
    expect(holder.getSnapshot()).toBe(clearedView);
    expect(notify).toHaveBeenCalledTimes(3);

    const changedAuthority: RoomAuthority = { ...authority, seatToken: SECOND_SEAT_TOKEN };
    holder.installAuthority(changedAuthority);
    holder.setRoom(waitingRoom());
    holder.dispose();
    const disposedView = holder.getSnapshot();

    expect(disposedView).toEqual({
      authority: null,
      room: null,
      session: null,
      sessionSnapshot: null,
    });
    expect(secondFixture.activeSubscriberCount()).toBe(0);
    expect(secondFixture.dispose).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(6);

    holder.dispose();
    secondFixture.emitDetached(sessionSnapshot('connected'));
    expect(holder.getSnapshot()).toBe(disposedView);
    expect(notify).toHaveBeenCalledTimes(6);
    expect(() => holder.installAuthority(authority)).toThrow('Game session holder is disposed');

    const lateNotify = vi.fn();
    holder.subscribe(lateNotify)();
    expect(lateNotify).not.toHaveBeenCalled();
  });

  test('retains matching room metadata across equal authority installation', () => {
    const fixture = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    holder.installAuthority(authority);
    const notify = vi.fn();
    holder.subscribe(notify);
    const room = waitingRoom();

    holder.setRoom(room);
    const roomView = holder.getSnapshot();

    expect(roomView.room).toBe(room);
    expect(notify).toHaveBeenCalledTimes(1);

    holder.setRoom(room);
    holder.installAuthority({ ...authority });
    expect(holder.getSnapshot()).toBe(roomView);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  test('ignores stale room metadata without disturbing subscribers', () => {
    const fixture = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    holder.installAuthority(authority);
    const notify = vi.fn();
    holder.subscribe(notify);
    const installedView = holder.getSnapshot();

    holder.setRoom(waitingRoom(OTHER_ROOM_ID));

    expect(holder.getSnapshot()).toBe(installedView);
    expect(notify).not.toHaveBeenCalled();
  });

  test('does not downgrade playing or finished room metadata to waiting', () => {
    const fixture = createSessionFixture();
    const holder = createGameSessionHolder({ createSession: () => fixture.session });
    holder.installAuthority(authority);
    const notify = vi.fn();
    holder.subscribe(notify);

    const playing = playingRoom();
    holder.setRoom(playing);
    const playingView = holder.getSnapshot();
    holder.setRoom(waitingRoom());
    expect(holder.getSnapshot()).toBe(playingView);
    expect(notify).toHaveBeenCalledTimes(1);

    const finished = finishedRoom();
    holder.setRoom(finished);
    const finishedView = holder.getSnapshot();
    holder.setRoom(waitingRoom());
    expect(holder.getSnapshot()).toBe(finishedView);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
