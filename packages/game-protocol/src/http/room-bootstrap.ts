import * as v from 'valibot';

import { publicErrorSchema } from '../errors/schemas';
import { safeParseWith } from '../internal/parse';
import { roomIdSchema, seatIndexSchema, seatTokenSchema } from '../internal/primitives';
import { responseMetaSchema, timedResponseMetaSchema } from '../version/validation';

export const authoritySchema = v.strictObject({
  roomId: roomIdSchema,
  seatIndex: seatIndexSchema,
  seatToken: seatTokenSchema,
});

export const safeParseRoomAuthority = (value: unknown) => safeParseWith(authoritySchema, value);

export function httpResponseSchema<
  const DataSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(dataSchema: DataSchema) {
  return v.union([
    v.strictObject({ ok: v.literal(true), data: dataSchema, meta: timedResponseMetaSchema }),
    v.strictObject({ ok: v.literal(false), error: publicErrorSchema, meta: responseMetaSchema }),
  ]);
}
