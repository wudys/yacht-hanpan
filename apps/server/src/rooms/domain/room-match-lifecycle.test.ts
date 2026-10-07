import { describe, expect, it } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { forfeitMatch, turnId } from '@/rooms/domain/match';
import { disconnectSeat, resumeSeat } from '@/rooms/domain/presence';
import { ROOM_REJECTION_CODE, ROOM_STATUS } from '@/rooms/domain/room-constants';
import {
  finishRoomMatch,
  markGameFinished,
  startRoomMatch,
} from '@/rooms/domain/room-match-lifecycle';
import { type PlayingRoom, roomId, type WaitingRoom } from '@/rooms/domain/room-model';
import { isFinishedRoomState, isPlayingRoomState } from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';

const creatorIndex = 0 as const;
const joinerIndex = 1 as const;

function waitingRoom(): WaitingRoom {
  const result = createRoom({
    roomId: roomId('room-1'),
    code: '012345',
    characterId: 'navy-bob',
    variant: false,
    createdAt: 1_000,
  });
  if (!result.ok) throw new Error('fixture creation failed');
  return result.room;
}

function playingRoom(): PlayingRoom {
  const result = joinRoom(waitingRoom(), {
    characterId: 'blonde-buns',
    variant: false,
    joinedAt: 2_000,
  });
  if (!result.ok || !result.changed) throw new Error('fixture join failed');
  return result.room;
}

describe('room match lifecycle', () => {
  it('starts a creator-first match for the validated playing room and supplied turn', () => {
    const room = playingRoom();
    const state = startRoomMatch(room, {
      id: turnId('initial-turn'),
      startedAt: epochMilliseconds(2_100),
    });

    expect(isPlayingRoomState(state)).toBeTrue();
    expect(state.room).toBe(room);
    expect(state.match.currentTurn).toMatchObject({
      id: 'initial-turn',
      seatIndex: 0,
      startedAt: 2_100,
      deadlineAt: 92_100,
    });
    expect(state.match.players.map((player) => player.scorecard)).toEqual([{}, {}]);
  });

  it('finishes room and match together without changing the playing input or its seats', () => {
    const current = startRoomMatch(playingRoom(), {
      id: turnId('initial-turn'),
      startedAt: epochMilliseconds(2_000),
    });
    const forfeited = forfeitMatch(current.match, { forfeitingSeatIndex: creatorIndex });
    if (!forfeited.ok || forfeited.match.status !== 'finished') {
      throw new Error('fixture forfeit failed');
    }
    const finished = finishRoomMatch(current, forfeited.match, 3_000);

    expect(finished.ok).toBeTrue();
    if (!finished.ok) throw new Error('finish failed');
    expect(isFinishedRoomState(finished.state)).toBeTrue();
    expect(finished.state.match).toBe(forfeited.match);
    expect(finished.state.room.finishedAt).toBe(epochMilliseconds(3_000));
    expect(finished.state.room.seats).toBe(current.room.seats);
    expect(current.room.status).toBe(ROOM_STATUS.PLAYING);
    expect(current.match.status).toBe('playing');
  });

  it.each([-1, 1_999])(
    'rejects invalid finish time %d without changing the playing state',
    (at) => {
      const current = startRoomMatch(playingRoom(), {
        id: turnId('initial-turn'),
        startedAt: epochMilliseconds(2_000),
      });
      const forfeited = forfeitMatch(current.match, { forfeitingSeatIndex: creatorIndex });
      if (!forfeited.ok || forfeited.match.status !== 'finished') {
        throw new Error('fixture forfeit failed');
      }

      expect(finishRoomMatch(current, forfeited.match, at)).toEqual({
        ok: false,
        reason: 'roomRejected',
        code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP,
      });
      expect(current.room.status).toBe(ROOM_STATUS.PLAYING);
      expect(current.match.status).toBe('playing');
    },
  );
});

describe('markGameFinished', () => {
  it('preserves seats and records a trusted finish time', () => {
    const room = playingRoom();
    const result = markGameFinished(room, { finishedAt: 10_000 });

    expect(result.room.status).toBe(ROOM_STATUS.FINISHED);
    if (result.room.status !== ROOM_STATUS.FINISHED) throw new Error('room did not finish');
    expect(Number(result.room.finishedAt)).toBe(10_000);
    expect(result.room.seats).toEqual(room.seats);
    expect(result.room.createdAt).toBe(room.createdAt);
    expect(result.room.startedAt).toBe(room.startedAt);
  });

  it('rejects waiting rooms and keeps a finished room unchanged only for valid timestamps', () => {
    const waiting = waitingRoom();
    expect(markGameFinished(waiting, { finishedAt: 3_000 })).toEqual({
      ok: false,
      changed: false,
      room: waiting,
      code: ROOM_REJECTION_CODE.ROOM_NOT_PLAYING,
    });
    const finished = markGameFinished(playingRoom(), { finishedAt: 10_000 });
    if (!finished.ok) throw new Error('fixture finish failed');
    expect(markGameFinished(finished.room, { finishedAt: 20_000 })).toEqual({
      ok: true,
      changed: false,
      room: finished.room,
    });
    expect(markGameFinished(finished.room, { finishedAt: -1 })).toEqual({
      ok: false,
      changed: false,
      room: finished.room,
      code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP,
    });
  });

  it('finishes a both-disconnected playing room when the Yacht match terminates', () => {
    const creatorConnected = resumeSeat(playingRoom(), {
      seatIndex: creatorIndex,
      resumedAt: 2_100,
    });
    if (!creatorConnected.ok || !creatorConnected.changed) {
      throw new Error('creator connection failed');
    }
    const joinerConnected = resumeSeat(creatorConnected.room, {
      seatIndex: joinerIndex,
      resumedAt: 2_200,
    });
    if (!joinerConnected.ok || !joinerConnected.changed) {
      throw new Error('joiner connection failed');
    }
    const creatorDisconnected = disconnectSeat(joinerConnected.room, {
      seatIndex: creatorIndex,
      detectedAt: 3_000,
    });
    if (!creatorDisconnected.ok || !creatorDisconnected.changed) {
      throw new Error('creator disconnect failed');
    }
    const bothDisconnected = disconnectSeat(creatorDisconnected.room, {
      seatIndex: joinerIndex,
      detectedAt: 4_000,
    });
    if (!bothDisconnected.ok || !bothDisconnected.changed) {
      throw new Error('joiner disconnect failed');
    }

    expect(markGameFinished(bothDisconnected.room, { finishedAt: 10_000 }).room).toMatchObject({
      status: ROOM_STATUS.FINISHED,
      finishedAt: 10_000,
      seats: bothDisconnected.room.seats,
    });
  });

  it.each([-1, 1_999])('rejects invalid finish time %d and preserves the room', (finishedAt) => {
    const room = playingRoom();

    expect(markGameFinished(room, { finishedAt })).toEqual({
      ok: false,
      changed: false,
      room,
      code: ROOM_REJECTION_CODE.INVALID_TIMESTAMP,
    });
  });
});

describe('terminal room recovery', () => {
  it('rejects resume after the game finishes', () => {
    const finished = markGameFinished(playingRoom(), { finishedAt: 10_000 });
    if (!finished.ok || !finished.changed) throw new Error('fixture finish failed');

    expect(resumeSeat(finished.room, { seatIndex: creatorIndex, resumedAt: 20_000 })).toEqual({
      ok: false,
      changed: false,
      room: finished.room,
      code: ROOM_REJECTION_CODE.ROOM_FINISHED,
    });
  });
});
