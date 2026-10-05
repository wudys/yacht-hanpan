import { describe, expect, test } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { forfeitMatch, turnId } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { evaluateSeatResume } from '@/rooms/domain/resume';
import { ROOM_REJECTION_CODE } from '@/rooms/domain/room-constants';
import { finishRoomMatch, startRoomMatch } from '@/rooms/domain/room-match-lifecycle';
import { roomId } from '@/rooms/domain/room-model';
import {
  isPlayingRoomState,
  type PlayingRoomState,
  type WaitingRoomState,
} from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';

function waitingState(): WaitingRoomState {
  const created = createRoom({
    roomId: roomId('resume-room'),
    code: '001204',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!created.ok) throw new Error('fixture create failed');
  return { room: created.room, match: null };
}

function playingState(): PlayingRoomState {
  const joined = joinRoom(waitingState().room, {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!joined.ok) throw new Error('fixture join failed');
  return startRoomMatch(joined.room, {
    id: turnId('resume-turn'),
    startedAt: epochMilliseconds(2_000),
  });
}

describe('evaluateSeatResume', () => {
  test('returns a waiting presence candidate and distinguishes an unchanged seat', () => {
    const current = waitingState();
    const resumed = evaluateSeatResume(current, { seatIndex: 0, resumedAt: 2_000 });
    expect(resumed.ok).toBeTrue();
    if (!resumed.ok) throw new Error('resume failed');
    expect(resumed.presenceChanged).toBeTrue();
    expect(resumed.state.room.seats[0].presence.status).toBe('connected');
    expect(resumed.state.match).toBeNull();
    expect(current.room.seats[0].presence.status).toBe('disconnected');

    const repeated = evaluateSeatResume(resumed.state, { seatIndex: 0, resumedAt: 2_001 });
    expect(repeated.ok).toBeTrue();
    if (!repeated.ok) throw new Error('repeated resume failed');
    expect(repeated.presenceChanged).toBeFalse();
    expect(repeated.state.room).toBe(resumed.state.room);
  });

  test('preserves the match and absent peer deadline while offering a playing candidate', () => {
    const initial = playingState();
    const connected = resumeSeat(initial.room, { seatIndex: 1, resumedAt: 3_000 });
    if (!connected.ok) throw new Error('fixture connect failed');
    const disconnected = disconnectSeat(connected.room, { seatIndex: 1, detectedAt: 4_000 });
    if (!disconnected.ok) throw new Error('fixture disconnect failed');
    const current: PlayingRoomState = { room: disconnected.room, match: initial.match };

    const resumed = evaluateSeatResume(current, { seatIndex: 0, resumedAt: 5_000 });
    if (!resumed.ok || !isPlayingRoomState(resumed.state)) throw new Error('playing resume failed');
    expect(resumed.presenceChanged).toBeTrue();
    expect(resumed.state.match).toBe(current.match);
    expect(resumed.state.room.seats[1].presence).toBe(current.room.seats[1].presence);
    expect(resumed.state.room.seats[1].presence).toEqual({
      status: 'disconnected',
      reconnectDeadlineAt: epochMilliseconds(94_000),
    });
    expect(current.room.seats[0].presence.status).toBe('disconnected');
  });

  test('allows a nonterminal overdue turn without applying its timeout or advancing it', () => {
    const current = playingState();
    const resumed = evaluateSeatResume(current, { seatIndex: 0, resumedAt: 92_000 });
    if (!resumed.ok || !isPlayingRoomState(resumed.state)) throw new Error('overdue resume failed');
    expect(resumed.state.match).toBe(current.match);
    expect(resumed.state.match.players[0].timeoutCount).toBe(0);
    expect(resumed.state.match.currentTurn.id).toBe(current.match.currentTurn.id);
  });

  test.each([91_999, 92_000, 92_001])(
    'checks terminal expiry for an already-connected seat at %d',
    (resumedAt) => {
      const initial = playingState();
      const connected = resumeSeat(initial.room, { seatIndex: 0, resumedAt: 3_000 });
      if (!connected.ok) throw new Error('fixture connect failed');
      const current: PlayingRoomState = {
        room: connected.room,
        match: {
          ...initial.match,
          players: [{ ...initial.match.players[0], timeoutCount: 1 }, initial.match.players[1]],
        },
      };
      const resumed = evaluateSeatResume(current, { seatIndex: 0, resumedAt });

      if (resumedAt < 92_000) {
        expect(resumed).toMatchObject({ ok: true, presenceChanged: false });
      } else {
        expect(resumed).toEqual({ ok: false, reason: 'terminalExpiry' });
      }
      expect(current.match.players[0].timeoutCount).toBe(1);
      expect(current.match.status).toBe('playing');
    },
  );

  test('retains room rejection precedence when reconnect and terminal turn expiry are both due', () => {
    const initial = playingState();
    const connected = resumeSeat(initial.room, { seatIndex: 0, resumedAt: 3_000 });
    if (!connected.ok) throw new Error('fixture connect failed');
    const disconnected = disconnectSeat(connected.room, { seatIndex: 0, detectedAt: 4_000 });
    if (!disconnected.ok) throw new Error('fixture disconnect failed');
    const current: PlayingRoomState = {
      room: disconnected.room,
      match: {
        ...initial.match,
        players: [{ ...initial.match.players[0], timeoutCount: 1 }, initial.match.players[1]],
      },
    };

    expect(evaluateSeatResume(current, { seatIndex: 0, resumedAt: 94_000 })).toEqual({
      ok: false,
      reason: 'roomRejected',
      code: ROOM_REJECTION_CODE.RECONNECT_NOT_AVAILABLE,
    });
    expect(current.match.players[0].timeoutCount).toBe(1);
  });

  test.each([
    [-1, ROOM_REJECTION_CODE.INVALID_TIMESTAMP],
    [4_000, ROOM_REJECTION_CODE.ROOM_FINISHED],
  ] as const)('keeps the owning room rejection for finished input at %d', (resumedAt, code) => {
    const current = playingState();
    const forfeited = forfeitMatch(current.match, { forfeitingSeatIndex: 0 });
    if (!forfeited.ok || forfeited.match.status !== 'finished') {
      throw new Error('fixture forfeit failed');
    }
    const finished = finishRoomMatch(current, forfeited.match, 3_000);
    if (!finished.ok) throw new Error('fixture finish failed');

    expect(evaluateSeatResume(finished.state, { seatIndex: 0, resumedAt })).toEqual({
      ok: false,
      reason: 'roomRejected',
      code,
    });
  });
});
