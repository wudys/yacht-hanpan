import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { clientIdSchema, operationIdSchema } from '../internal/primitives';
import { profileSelectionSchema, waitingRoomViewSchema } from '../state/room-view';
import { authoritySchema, httpResponseSchema } from './room-http-schemas';

const createRoomRequestSchema = v.strictObject({
  clientId: clientIdSchema,
  operationId: operationIdSchema,
  profile: profileSelectionSchema,
});

const createRoomDataSchema = v.pipe(
  v.strictObject({
    authority: v.strictObject({ ...authoritySchema.entries, seatIndex: v.literal(0) }),
    view: waitingRoomViewSchema,
  }),
  v.check(({ authority, view }) => authority.roomId === view.room.roomId),
);

const createRoomResponseSchema = httpResponseSchema(createRoomDataSchema);

export type CreateRoomRequest = v.InferOutput<typeof createRoomRequestSchema>;
export type CreateRoomResponse = v.InferOutput<typeof createRoomResponseSchema>;

export const parseCreateRoomRequest = (value: unknown): CreateRoomRequest =>
  parseWith(createRoomRequestSchema, value);
export const parseCreateRoomResponse = (value: unknown): CreateRoomResponse =>
  parseWith(createRoomResponseSchema, value);
