import { CHARACTER_IDS } from '@repo/game-assets/characters';
import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import {
  epochMillisecondsSchema,
  presenceVersionSchema,
  roomCodeSchema,
  roomIdSchema,
  seatIndexSchema,
  stateVersionSchema,
  turnIdSchema,
} from '../internal/primitives';
import type { DeepReadonly } from '../internal/readonly';
import {
  CATEGORY_ID,
  MATCH_END_REASON,
  MATCH_STATUS,
  PRESENCE_STATUS,
  ROOM_STATUS,
} from './constants';

export const profileSelectionSchema = v.strictObject({
  characterId: v.picklist(CHARACTER_IDS),
  variant: v.boolean(),
});

const seatSchema = v.strictObject({
  profile: profileSelectionSchema,
});

const roomIdentityEntries = {
  roomId: roomIdSchema,
  roomCode: roomCodeSchema,
  createdAt: epochMillisecondsSchema,
} as const;

export const waitingRoomSchema = v.strictObject({
  status: v.literal(ROOM_STATUS.WAITING),
  ...roomIdentityEntries,
  expiresAt: epochMillisecondsSchema,
  seats: v.strictTuple([seatSchema]),
});

export const playingRoomSchema = v.strictObject({
  status: v.literal(ROOM_STATUS.PLAYING),
  ...roomIdentityEntries,
  startedAt: epochMillisecondsSchema,
  seats: v.strictTuple([seatSchema, seatSchema]),
});

export const finishedRoomSchema = v.strictObject({
  status: v.literal(ROOM_STATUS.FINISHED),
  ...roomIdentityEntries,
  startedAt: epochMillisecondsSchema,
  finishedAt: epochMillisecondsSchema,
  seats: v.strictTuple([seatSchema, seatSchema]),
});

export const publicRoomSchema = v.variant('status', [
  waitingRoomSchema,
  playingRoomSchema,
  finishedRoomSchema,
]);

const connectedPresenceSchema = v.strictObject({
  status: v.literal(PRESENCE_STATUS.CONNECTED),
});

const disconnectedPresenceSchema = v.strictObject({
  status: v.literal(PRESENCE_STATUS.DISCONNECTED),
  reconnectDeadlineAt: v.nullable(epochMillisecondsSchema),
});

const seatPresenceSchema = v.variant('status', [
  connectedPresenceSchema,
  disconnectedPresenceSchema,
]);

export const presenceSnapshotSchema = v.strictObject({
  roomId: roomIdSchema,
  presenceVersion: presenceVersionSchema,
  seats: v.union([
    v.strictTuple([seatPresenceSchema]),
    v.strictTuple([seatPresenceSchema, seatPresenceSchema]),
  ]),
});

const scoreSchema = v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0), v.maxValue(50));

const scorecardSchema = v.strictObject({
  [CATEGORY_ID.ONES]: v.optional(scoreSchema),
  [CATEGORY_ID.TWOS]: v.optional(scoreSchema),
  [CATEGORY_ID.THREES]: v.optional(scoreSchema),
  [CATEGORY_ID.FOURS]: v.optional(scoreSchema),
  [CATEGORY_ID.FIVES]: v.optional(scoreSchema),
  [CATEGORY_ID.SIXES]: v.optional(scoreSchema),
  [CATEGORY_ID.CHOICE]: v.optional(scoreSchema),
  [CATEGORY_ID.FOUR_OF_A_KIND]: v.optional(scoreSchema),
  [CATEGORY_ID.FULL_HOUSE]: v.optional(scoreSchema),
  [CATEGORY_ID.SMALL_STRAIGHT]: v.optional(scoreSchema),
  [CATEGORY_ID.LARGE_STRAIGHT]: v.optional(scoreSchema),
  [CATEGORY_ID.YACHT]: v.optional(scoreSchema),
});

const matchPlayerSchema = v.strictObject({
  scorecard: scorecardSchema,
  timeoutCount: v.picklist([0, 1, 2, 3]),
});

const dieSchema = v.strictObject({
  value: v.picklist([1, 2, 3, 4, 5, 6]),
});

const diceSchema = v.strictTuple([dieSchema, dieSchema, dieSchema, dieSchema, dieSchema]);

const turnIdentityEntries = {
  turnId: turnIdSchema,
  seatIndex: seatIndexSchema,
  startedAt: epochMillisecondsSchema,
  deadlineAt: epochMillisecondsSchema,
} as const;

const emptyTurnSchema = v.strictObject({
  ...turnIdentityEntries,
  heldSlots: v.strictTuple([]),
  rollCount: v.literal(0),
  dice: v.null(),
});

const rolledTurnSchema = v.strictObject({
  ...turnIdentityEntries,
  rollCount: v.picklist([1, 2, 3]),
  dice: diceSchema,
  heldSlots: v.pipe(
    v.array(v.picklist([0, 1, 2, 3, 4])),
    v.maxLength(5),
    v.check((slots) => new Set(slots).size === slots.length),
  ),
});

const turnSchema = v.variant('rollCount', [emptyTurnSchema, rolledTurnSchema]);

const playersSchema = v.strictTuple([matchPlayerSchema, matchPlayerSchema]);

const scoresCompletedResultSchema = v.strictObject({
  reason: v.literal(MATCH_END_REASON.SCORES_COMPLETED),
  winnerSeatIndex: v.nullable(seatIndexSchema),
});

const decidedResultSchema = v.strictObject({
  reason: v.picklist([
    MATCH_END_REASON.EXPLICIT_FORFEIT,
    MATCH_END_REASON.TIMEOUT_LIMIT,
    MATCH_END_REASON.CONNECTION_ENDED,
  ]),
  winnerSeatIndex: seatIndexSchema,
});

const playingMatchSchema = v.strictObject({
  status: v.literal(MATCH_STATUS.PLAYING),
  players: playersSchema,
  currentTurn: turnSchema,
});

const finishedMatchSchema = v.strictObject({
  status: v.literal(MATCH_STATUS.FINISHED),
  players: playersSchema,
  result: v.union([scoresCompletedResultSchema, decidedResultSchema]),
});

export const gameSnapshotSchema = v.strictObject({
  stateVersion: stateVersionSchema,
  match: v.variant('status', [playingMatchSchema, finishedMatchSchema]),
});

const roomViewEntries = {
  room: publicRoomSchema,
  game: v.nullable(gameSnapshotSchema),
  presence: presenceSnapshotSchema,
} as const;

export const roomViewSchema = v.pipe(
  v.strictObject(roomViewEntries),
  v.check((state) => hasCoherentPublicState(state)),
);

export const waitingRoomViewSchema = v.pipe(
  v.strictObject({ ...roomViewEntries, room: waitingRoomSchema, game: v.null() }),
  v.check((state) => hasCoherentPublicState(state)),
);

export const playingRoomViewSchema = v.pipe(
  v.strictObject({ ...roomViewEntries, room: playingRoomSchema, game: gameSnapshotSchema }),
  v.check((state) => hasCoherentPublicState(state)),
);

export type PublicRoomInput = v.InferInput<typeof publicRoomSchema>;
export type PresenceSnapshotInput = v.InferInput<typeof presenceSnapshotSchema>;
export type GameSnapshotInput = v.InferInput<typeof gameSnapshotSchema>;
export type RoomViewInput = v.InferInput<typeof roomViewSchema>;

export type PublicRoom = DeepReadonly<v.InferOutput<typeof publicRoomSchema>>;
export type PresenceSnapshot = DeepReadonly<v.InferOutput<typeof presenceSnapshotSchema>>;
export type GameSnapshot = DeepReadonly<v.InferOutput<typeof gameSnapshotSchema>>;
export type RoomView = DeepReadonly<v.InferOutput<typeof roomViewSchema>>;

export const parsePublicRoom = (value: unknown): PublicRoom => parseWith(publicRoomSchema, value);
export const parsePresenceSnapshot = (value: unknown): PresenceSnapshot =>
  parseWith(presenceSnapshotSchema, value);
export const parseGameSnapshot = (value: unknown): GameSnapshot =>
  parseWith(gameSnapshotSchema, value);
export const parseRoomView = (value: unknown): RoomView => parseWith(roomViewSchema, value);

function hasCoherentPublicState({
  room,
  game,
  presence,
}: {
  readonly room: PublicRoom;
  readonly game: GameSnapshot | null;
  readonly presence: PresenceSnapshot;
}): boolean {
  const gameMatchesRoom =
    (room.status === ROOM_STATUS.WAITING && game === null) ||
    (room.status === ROOM_STATUS.PLAYING && game?.match.status === MATCH_STATUS.PLAYING) ||
    (room.status === ROOM_STATUS.FINISHED && game?.match.status === MATCH_STATUS.FINISHED);
  return (
    room.roomId === presence.roomId &&
    room.seats.length === presence.seats.length &&
    gameMatchesRoom
  );
}
