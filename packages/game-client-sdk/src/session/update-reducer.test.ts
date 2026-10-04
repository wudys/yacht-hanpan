import { parseCommittedRoomUpdate, parseRoomView } from '@repo/game-protocol/socket';
import { describe, expect, test } from 'bun:test';

import { createSessionState, reduceCommittedUpdate, reduceRoomView } from './update-reducer';

const ROOM_ID = '01890f47-e89b-7cc3-98c5-4c5da03f78ab';
const TURN_ID = 'de305d54-75b4-431b-adb2-eb6b9e546018';

function view(stateVersion: number, presenceVersion = 1) {
  return parseRoomView({
    room: {
      status: 'playing',
      roomId: ROOM_ID,
      roomCode: '001204',
      createdAt: 1000,
      startedAt: 2000,
      seats: [
        { profile: { characterId: 'navy-bob', variant: false } },
        { profile: { characterId: 'blonde-buns', variant: false } },
      ],
    },
    game: {
      stateVersion,
      match: {
        status: 'playing',
        players: [
          { scorecard: {}, timeoutCount: 0 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        currentTurn: {
          turnId: TURN_ID,
          seatIndex: 0,
          startedAt: 1,
          deadlineAt: 60001,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    },
    presence: {
      roomId: ROOM_ID,
      presenceVersion,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    },
  });
}

describe('authoritative whole-view acceptance', () => {
  test('accepts a baseline and a coherent version jump as settled complete views', () => {
    const baselineUpdate = parseCommittedRoomUpdate({ type: 'state:committed', view: view(1) });
    const baseline = reduceCommittedUpdate(createSessionState(), baselineUpdate);
    expect(baseline.kind).toBe('applied');
    if (baseline.kind !== 'applied') throw new Error('expected applied baseline');
    const jumpUpdate = parseCommittedRoomUpdate({ type: 'state:committed', view: view(5, 3) });
    const jump = reduceCommittedUpdate(baseline.state, jumpUpdate);
    expect(jump.kind).toBe('applied');
    if (jump.kind !== 'applied') throw new Error('expected applied jump');
    expect(jump.state.view).toBe(jumpUpdate.view);
    expect(jump.state.presentation).toEqual({ kind: 'settled' });
  });

  test.each([
    { game: 5, presence: 6, kind: 'applied' },
    { game: 6, presence: 5, kind: 'applied' },
    { game: 6, presence: 6, kind: 'applied' },
    { game: 5, presence: 5, kind: 'ignored' },
    { game: 4, presence: 5, kind: 'ignored' },
    { game: 5, presence: 4, kind: 'ignored' },
    { game: 4, presence: 4, kind: 'ignored' },
    { game: 4, presence: 6, kind: 'invalid' },
    { game: 6, presence: 4, kind: 'invalid' },
  ] as const)('keeps the complete view indivisible for $game/$presence: $kind', (candidate) => {
    const current = {
      view: view(5, 5),
      presentation: { kind: 'settled' as const },
    };
    const incoming = view(candidate.game, candidate.presence);
    const reduction = reduceRoomView(current, incoming);
    expect(reduction.kind).toBe(candidate.kind);
    if (reduction.kind === 'applied') expect(reduction.state.view).toBe(incoming);
    if (reduction.kind === 'ignored') expect(reduction.state).toBe(current);
    expect(Number(current.view.game?.stateVersion)).toBe(5);
    expect(Number(current.view.presence.presenceVersion)).toBe(5);
  });

  test('a stale waiting view cannot replace playing lifecycle or profiles', () => {
    const current = {
      view: view(5, 5),
      presentation: { kind: 'settled' as const },
    };
    const waiting = parseRoomView({
      room: {
        status: 'waiting',
        roomId: ROOM_ID,
        roomCode: '001204',
        createdAt: 1000,
        expiresAt: 301000,
        seats: [{ profile: { characterId: 'black-hime', variant: false } }],
      },
      game: null,
      presence: { roomId: ROOM_ID, presenceVersion: 4, seats: [{ status: 'connected' }] },
    });
    const reduction = reduceRoomView(current, waiting);
    expect(reduction).toEqual({ kind: 'ignored', state: current });
    expect(current.view.room.seats[0].profile.characterId).toBe('navy-bob');
  });
});
