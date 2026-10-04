import { describe, expect, test } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import type { RoomEventTime } from '@/rooms/domain/event-time';
import { joinRoom } from '@/rooms/domain/join-room';
import { turnId } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { applyRoomDeadlineDecision, evaluateRoomDeadlines } from '@/rooms/domain/room-deadlines';
import { startRoomMatch } from '@/rooms/domain/room-lifecycle';
import { roomId } from '@/rooms/domain/room-model';
import type { PlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';

function playingState(deadlineAt: number, timeoutCount: 0 | 2 = 0): PlayingRoomState {
  const created = createRoom({
    roomId: roomId('deadline-room'),
    code: '001204',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('fixture create failed');
  const joined = joinRoom(created.room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  const initial = startRoomMatch(joined.room, {
    id: turnId('initial-turn'),
    startedAt: epochMilliseconds(2_000),
  });
  const connected = resumeSeat(initial.room, { seatIndex: 1, resumedAt: 3_000 });
  if (!connected.ok) throw new Error('fixture connect failed');
  const disconnected = disconnectSeat(connected.room, { seatIndex: 1, detectedAt: 4_000 });
  if (!disconnected.ok) throw new Error('fixture disconnect failed');
  return {
    room: disconnected.room,
    match: {
      ...initial.match,
      players: [{ ...initial.match.players[0], timeoutCount }, initial.match.players[1]],
      currentTurn: { ...initial.match.currentTurn, deadlineAt: epochMilliseconds(deadlineAt) },
    },
  };
}

describe('room deadline decisions', () => {
  test.each([
    ['command', 93_999, 94_000, 'unchanged', null],
    ['command', 94_000, 94_000, 'timeout', null],
    ['command', 94_001, 94_000, 'timeout', 1],
    ['deadline', 94_000, 94_000, 'timeout', 1],
    ['command', 94_000, 100_000, 'unchanged', null],
    ['deadline', 94_000, 100_000, 'connectionEnded', null],
  ] as const)(
    'decides %s at %d with turn deadline %d without mutating the input',
    (source, effectiveAt, deadlineAt, kind, connectionAfterTimeout) => {
      const current = playingState(deadlineAt);
      const before = structuredClone(current);
      const time: RoomEventTime =
        source === 'command'
          ? { source, effectiveAt, priority: 'gameplay' }
          : { source, effectiveAt };
      const decision = evaluateRoomDeadlines(current, time);

      expect(decision.kind).toBe(kind);
      if (decision.kind === 'timeout') {
        expect(decision.expiry.kind).toBe('advance');
        expect(decision.connectionAfterTimeout).toBe(connectionAfterTimeout);
      }
      expect(current).toEqual(before);
    },
  );

  test.each([0, 2] as const)(
    'applies one timeout before a due connection end at count %d',
    (count) => {
      const current = playingState(94_000, count);
      const decision = evaluateRoomDeadlines(current, { source: 'deadline', effectiveAt: 94_000 });
      if (decision.kind !== 'timeout') throw new Error('expected timeout decision');
      const applied = applyRoomDeadlineDecision(current, {
        ...decision,
        committedAt: 94_100,
        nextTurn: { id: turnId('next-turn'), startedAt: epochMilliseconds(94_100) },
      });

      expect(applied).toMatchObject({
        changed: true,
        state: {
          room: { status: 'finished', finishedAt: 94_100 },
          match: {
            status: 'finished',
            players: [{ timeoutCount: count + 1 }, { timeoutCount: 0 }],
            result: { reason: count === 2 ? 'timeoutLimit' : 'connectionEnded' },
          },
        },
      });
      expect(current.match.players[0].timeoutCount).toBe(count);
    },
  );

  test('starts the next turn from supplied commit time after a nonterminal decision', () => {
    const current = playingState(10_000);
    const decision = evaluateRoomDeadlines(current, { source: 'deadline', effectiveAt: 10_000 });
    if (decision.kind !== 'timeout') throw new Error('expected timeout decision');
    const applied = applyRoomDeadlineDecision(current, {
      ...decision,
      committedAt: 11_000,
      nextTurn: { id: turnId('supplied-turn'), startedAt: epochMilliseconds(11_000) },
    });
    expect(applied).toMatchObject({
      changed: true,
      state: {
        match: {
          status: 'playing',
          players: [{ timeoutCount: 1 }, { timeoutCount: 0 }],
          currentTurn: { id: 'supplied-turn', seatIndex: 1, startedAt: 11_000, deadlineAt: 71_000 },
        },
      },
    });
  });
});
