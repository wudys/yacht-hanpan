import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { roomIdSchema, seatTokenSchema } from '../internal/primitives';
import { httpResponseSchema } from './room-http-schemas';

const cancelRoomBodySchema = v.strictObject({
  seatToken: seatTokenSchema,
});

const cancelRoomRequestSchema = v.strictObject({
  roomId: roomIdSchema,
  ...cancelRoomBodySchema.entries,
});

const cancelRoomResponseSchema = httpResponseSchema(v.strictObject({ cancelled: v.literal(true) }));

export type CancelRoomBody = v.InferOutput<typeof cancelRoomBodySchema>;
export type CancelRoomRequest = v.InferOutput<typeof cancelRoomRequestSchema>;
export type CancelRoomResponse = v.InferOutput<typeof cancelRoomResponseSchema>;

export const parseCancelRoomBody = (value: unknown): CancelRoomBody =>
  parseWith(cancelRoomBodySchema, value);
export const parseCancelRoomRequest = (value: unknown): CancelRoomRequest =>
  parseWith(cancelRoomRequestSchema, value);
export const parseCancelRoomResponse = (value: unknown): CancelRoomResponse =>
  parseWith(cancelRoomResponseSchema, value);
