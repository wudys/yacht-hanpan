import * as v from 'valibot';

import { publicErrorSchema } from '../errors/schemas';
import { parseWith } from '../internal/parse';
import { roomIdSchema, seatTokenSchema } from '../internal/primitives';
import { compatibilityContractSchema, responseMetaSchema } from '../version/validation';

export const SOCKET_CONNECTION_INTENT = {
  ENTER: 'enter',
  RECONNECT: 'reconnect',
} as const;

const socketAuthSchema = v.strictObject({
  roomId: roomIdSchema,
  seatToken: seatTokenSchema,
  contract: compatibilityContractSchema,
  executionId: v.pipe(v.string(), v.uuid()),
  connectionIntent: v.picklist(Object.values(SOCKET_CONNECTION_INTENT)),
});

export type SocketAuth = v.InferOutput<typeof socketAuthSchema>;

const socketConnectionFailureSchema = v.strictObject({
  ok: v.literal(false),
  error: publicErrorSchema,
  meta: responseMetaSchema,
});

export type SocketConnectionFailure = v.InferOutput<typeof socketConnectionFailureSchema>;

export const parseSocketAuth = (value: unknown): SocketAuth => parseWith(socketAuthSchema, value);
export const parseSocketConnectionFailure = (value: unknown): SocketConnectionFailure =>
  parseWith(socketConnectionFailureSchema, value);
