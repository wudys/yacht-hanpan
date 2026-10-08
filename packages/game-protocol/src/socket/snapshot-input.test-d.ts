import type {
  GameSnapshotInput,
  PresenceSnapshotInput,
  PublicRoomInput,
} from '@repo/game-protocol/state';

type Player = GameSnapshotInput['match']['players'][number];

// @ts-expect-error A projected player must retain the required timeout counter.
export const missingTimeout: Player = { scorecard: {} };
// @ts-expect-error A misspelled wire field must not pass projection typechecking.
export const misspelledTimeout: Player = { scorecard: {}, timeoutCounnt: 0 };
// @ts-expect-error A disconnected seat must carry its reconnect deadline, including null.
export const missingDeadline: PresenceSnapshotInput['seats'][number] = { status: 'disconnected' };
// @ts-expect-error A waiting room has exactly one seat, not a playing-room seat tuple.
export const extraWaitingSeat: Extract<PublicRoomInput, { status: 'waiting' }>['seats'] = [
  { profile: { characterId: 'navy-bob', variant: false } },
  { profile: { characterId: 'navy-bob', variant: false } },
];
