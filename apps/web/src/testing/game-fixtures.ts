import type { CommandResult } from '@repo/game-client-sdk';
import { safeParseRoomAuthority } from '@repo/game-protocol/http';
import { parseCommandAck } from '@repo/game-protocol/socket';
import {
  type GameSnapshot,
  type GameSnapshotInput,
  parseGameSnapshot,
  parsePublicRoom,
} from '@repo/game-protocol/state';
import { GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';

function parseAuthority(value: unknown) {
  const result = safeParseRoomAuthority(value);
  if (!result.success) throw result.error;
  return result.output;
}

export const authority = parseAuthority({
  roomId: '019976a2-d8d8-7000-8000-000000000001',
  seatIndex: 0,
  seatToken: '11111111-1111-4111-8111-111111111111',
});

export const room = parsePublicRoom({
  status: 'playing',
  roomId: authority.roomId,
  roomCode: '001234',
  createdAt: 1,
  startedAt: 2,
  seats: [
    { profile: { characterId: 'navy-bob', variant: false } },
    { profile: { characterId: 'blonde-buns', variant: true } },
  ],
});

export const waitingRoom = parsePublicRoom({
  status: 'waiting',
  roomId: authority.roomId,
  roomCode: '001234',
  createdAt: 1,
  expiresAt: 61_000,
  seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
});

export const playingGameInput = {
  stateVersion: 7,
  match: {
    status: 'playing',
    players: [
      { scorecard: { ones: 2 }, timeoutCount: 0 },
      { scorecard: { ones: 1 }, timeoutCount: 0 },
    ],
    currentTurn: {
      turnId: '11111111-1111-4111-8111-000000000001',
      seatIndex: 0,
      startedAt: 1_000,
      deadlineAt: 61_000,
      rollCount: 1,
      heldSlots: [1],
      dice: [{ value: 2 }, { value: 3 }, { value: 4 }, { value: 5 }, { value: 6 }],
    },
  },
} satisfies GameSnapshotInput;
export const playingGame = parseGameSnapshot(playingGameInput);
export const initialPlayingMatch = (() => {
  const { match } = playingGameInput;
  const { currentTurn } = match;
  return { ...match, currentTurn };
})();

export function finishedGame(
  reason: 'scoresCompleted' | 'explicitForfeit' | 'timeoutLimit' | 'connectionEnded',
  winnerSeatIndex: 0 | 1 | null,
  players: GameSnapshot['match']['players'] = playingGame.match.players,
): GameSnapshot {
  return parseGameSnapshot({
    stateVersion: 8,
    match: {
      status: 'finished',
      players,
      result: { reason, winnerSeatIndex },
    },
  });
}

export function commandSuccess(stateVersion: number = 8): Extract<CommandResult, { ok: true }> {
  const ack = parseCommandAck({
    ok: true,
    data: {
      receipt: { stateVersion },
      view: {
        room,
        game: { ...playingGame, stateVersion },
        presence: {
          roomId: authority.roomId,
          presenceVersion: 1,
          seats: [{ status: 'connected' }, { status: 'connected' }],
        },
      },
    },
    meta: {
      actionId: '11111111-1111-4111-8111-000000000002',
      requestId: '11111111-1111-4111-8111-000000000003',
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
    },
  });
  if (!ack.ok) throw new Error('Expected command success');
  return {
    ok: true,
    data: ack.data.receipt,
    actionId: ack.meta.actionId,
    requestId: ack.meta.requestId,
  };
}
