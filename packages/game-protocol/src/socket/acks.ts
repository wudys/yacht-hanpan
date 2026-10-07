import * as v from 'valibot';

import { PUBLIC_ERROR_CODE } from '../errors/constants';
import { publicErrorSchema } from '../errors/schemas';
import { GameApiParseError, parseWith } from '../internal/parse';
import { actionIdSchema, requestIdSchema, stateVersionSchema } from '../internal/primitives';
import type { DeepReadonly } from '../internal/readonly';
import { roomViewSchema } from '../state/room-view';
import { GAME_PROTOCOL_VERSION } from '../version';
import { responseMetaSchema, timedResponseMetaSchema } from '../version/validation';
import { resolvedRollArtifactSchema, rollMatchesGameSnapshot } from './roll-artifact';

const commandMetaEntries = {
  requestId: requestIdSchema,
  gameProtocolVersion: v.literal(GAME_PROTOCOL_VERSION),
} as const;

const commandMetaSchema = v.strictObject({
  ...commandMetaEntries,
  actionId: actionIdSchema,
});

const commandFailureMetaSchema = v.strictObject({
  ...commandMetaEntries,
  actionId: v.nullable(actionIdSchema),
});

const commandReceiptSchema = v.union([
  v.strictObject({ stateVersion: stateVersionSchema }),
  v.strictObject({ stateVersion: stateVersionSchema, roll: resolvedRollArtifactSchema }),
]);

const commandSuccessDataSchema = v.pipe(
  v.strictObject({ receipt: commandReceiptSchema, view: roomViewSchema }),
  v.check(({ receipt, view }) => {
    if (view.game === null || receipt.stateVersion > view.game.stateVersion) return false;
    return (
      receipt.stateVersion < view.game.stateVersion ||
      !('roll' in receipt) ||
      rollMatchesGameSnapshot(view.game, receipt.roll)
    );
  }),
);

const commandAckSchema = v.union([
  v.strictObject({
    ok: v.literal(true),
    data: commandSuccessDataSchema,
    meta: commandMetaSchema,
  }),
  v.strictObject({
    ok: v.literal(false),
    error: publicErrorSchema,
    meta: commandFailureMetaSchema,
  }),
  v.strictObject({
    ok: v.literal(false),
    error: v.strictObject({
      code: v.literal(PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED),
      params: v.strictObject({}),
    }),
    recovery: roomViewSchema,
    meta: commandMetaSchema,
  }),
]);

const syncAckSchema = v.union([
  v.strictObject({
    ok: v.literal(true),
    data: roomViewSchema,
    meta: timedResponseMetaSchema,
  }),
  v.strictObject({ ok: v.literal(false), error: publicErrorSchema, meta: responseMetaSchema }),
]);

type ParsedCommandAck = v.InferOutput<typeof commandAckSchema>;
type CommandMeta = v.InferOutput<typeof commandMetaSchema>;
type CommandError = v.InferOutput<typeof publicErrorSchema>;

export type CommandAck =
  | Extract<ParsedCommandAck, { ok: true }>
  | {
      readonly ok: false;
      readonly error: Extract<CommandError, { code: typeof PUBLIC_ERROR_CODE.INVALID_REQUEST }>;
      readonly meta: v.InferOutput<typeof commandFailureMetaSchema>;
      readonly recovery?: never;
    }
  | {
      readonly ok: false;
      readonly error: Extract<
        CommandError,
        { code: typeof PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED }
      >;
      readonly meta: CommandMeta;
      readonly recovery: v.InferOutput<typeof roomViewSchema>;
    }
  | {
      readonly ok: false;
      readonly error: Exclude<
        CommandError,
        {
          code:
            | typeof PUBLIC_ERROR_CODE.INVALID_REQUEST
            | typeof PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED;
        }
      >;
      readonly meta: CommandMeta;
      readonly recovery?: never;
    };
export type CommandReceipt = DeepReadonly<v.InferOutput<typeof commandReceiptSchema>>;
export type SyncAck = v.InferOutput<typeof syncAckSchema>;

export function parseCommandAck(value: unknown): CommandAck {
  const parsed = parseWith(commandAckSchema, value);
  if (parsed.ok) return parsed;
  const hasRecovery = 'recovery' in parsed;
  if (parsed.error.code === PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED) {
    if (!hasRecovery || parsed.meta.actionId === null) throw new GameApiParseError();
    return { ok: false, error: parsed.error, meta: parsed.meta, recovery: parsed.recovery };
  }
  if (hasRecovery) throw new GameApiParseError();
  if (parsed.error.code === PUBLIC_ERROR_CODE.INVALID_REQUEST) {
    return { ok: false, error: parsed.error, meta: parsed.meta };
  }
  if (parsed.meta.actionId === null) throw new GameApiParseError();
  return {
    ok: false,
    error: parsed.error,
    meta: { ...parsed.meta, actionId: parsed.meta.actionId },
  };
}
export const parseSyncAck = (value: unknown): SyncAck => parseWith(syncAckSchema, value);
