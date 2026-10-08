import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { roomIdSchema, seatIndexSchema, seatTokenSchema } from '../internal/primitives';
import { roomViewSchema } from '../state/room-view';
import { httpResponseSchema } from './room-http-schemas';

const resumeRoomBodySchema = v.strictObject({
  seatToken: seatTokenSchema,
});

const resumeRoomRequestSchema = v.strictObject({
  roomId: roomIdSchema,
  ...resumeRoomBodySchema.entries,
});

const resumeRoomResponseSchema = httpResponseSchema(
  v.pipe(
    v.strictObject({ seatIndex: seatIndexSchema, view: roomViewSchema }),
    v.check(({ seatIndex, view }) => seatIndex < view.room.seats.length),
  ),
);

export type ResumeRoomBody = v.InferOutput<typeof resumeRoomBodySchema>;
export type ResumeRoomRequest = v.InferOutput<typeof resumeRoomRequestSchema>;
export type ResumeRoomResponse = v.InferOutput<typeof resumeRoomResponseSchema>;

export const parseResumeRoomBody = (value: unknown): ResumeRoomBody =>
  parseWith(resumeRoomBodySchema, value);
export const parseResumeRoomRequest = (value: unknown): ResumeRoomRequest =>
  parseWith(resumeRoomRequestSchema, value);
export const parseResumeRoomResponse = (value: unknown): ResumeRoomResponse =>
  parseWith(resumeRoomResponseSchema, value);
