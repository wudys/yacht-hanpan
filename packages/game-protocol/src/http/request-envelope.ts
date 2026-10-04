import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { compatibilityContractSchema } from '../version/validation';

const roomHttpEnvelopeSchema = v.strictObject({
  contract: compatibilityContractSchema,
  body: v.unknown(),
});

export type RoomHttpEnvelope = v.InferOutput<typeof roomHttpEnvelopeSchema>;

export const parseRoomHttpEnvelope = (value: unknown): RoomHttpEnvelope =>
  parseWith(roomHttpEnvelopeSchema, value);
