import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { clientIdSchema, operationIdSchema, roomCodeSchema } from '../internal/primitives';
import { playingRoomViewSchema, profileSelectionSchema } from '../state/room-view';
import { authoritySchema, httpResponseSchema } from './room-bootstrap';

const joinRoomBodySchema = v.strictObject({
  clientId: clientIdSchema,
  operationId: operationIdSchema,
  profile: profileSelectionSchema,
});

const joinRoomRequestSchema = v.strictObject({
  ...joinRoomBodySchema.entries,
  roomCode: roomCodeSchema,
});

const joinRoomDataSchema = v.pipe(
  v.strictObject({
    authority: v.strictObject({ ...authoritySchema.entries, seatIndex: v.literal(1) }),
    view: playingRoomViewSchema,
  }),
  v.check(({ authority, view }) => authority.roomId === view.room.roomId),
);

const joinRoomResponseSchema = httpResponseSchema(joinRoomDataSchema);

export type JoinRoomBody = v.InferOutput<typeof joinRoomBodySchema>;
export type JoinRoomRequest = v.InferOutput<typeof joinRoomRequestSchema>;
export type JoinRoomResponse = v.InferOutput<typeof joinRoomResponseSchema>;

export const parseJoinRoomBody = (value: unknown): JoinRoomBody =>
  parseWith(joinRoomBodySchema, value);
export const parseJoinRoomRequest = (value: unknown): JoinRoomRequest =>
  parseWith(joinRoomRequestSchema, value);
export const parseJoinRoomResponse = (value: unknown): JoinRoomResponse =>
  parseWith(joinRoomResponseSchema, value);
