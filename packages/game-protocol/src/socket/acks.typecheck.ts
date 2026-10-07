import { PUBLIC_ERROR_CODE } from '../errors/constants';
import type { CommandAck } from './acks';

declare const meta: Extract<CommandAck, { ok: true }>['meta'];
declare const data: Extract<CommandAck, { ok: true }>['data'];
declare const recovery: Extract<CommandAck, { ok: false; recovery: unknown }>['recovery'];

export const success: CommandAck = { ok: true, data, meta };
export const malformed: CommandAck = {
  ok: false,
  error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST, params: {} },
  meta: { ...meta, actionId: null },
};
export const invalidIdentified: CommandAck = {
  ok: false,
  error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST, params: {} },
  meta,
};
export const expired: CommandAck = {
  ok: false,
  error: { code: PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, params: {} },
  recovery,
  meta,
};
export const ordinary: CommandAck = {
  ok: false,
  error: { code: PUBLIC_ERROR_CODE.STALE_TURN, params: {} },
  meta,
};
export const limited: CommandAck = {
  ok: false,
  error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 1_000 } },
  meta,
};

// @ts-expect-error Only INVALID_REQUEST can lack an action identifier.
export const invalidNull: CommandAck = { ...ordinary, meta: { ...meta, actionId: null } };
// @ts-expect-error An expired action result requires a recovery view.
export const expiredWithoutRecovery: CommandAck = { ok: false, error: expired.error, meta };
// @ts-expect-error Ordinary failures cannot carry recovery.
export const ordinaryWithRecovery: CommandAck = { ...ordinary, recovery };
// @ts-expect-error Malformed command failures cannot carry recovery.
export const malformedWithRecovery: CommandAck = { ...malformed, recovery };
// @ts-expect-error Recovery must identify the expired command.
export const expiredWithNull: CommandAck = { ...expired, meta: { ...meta, actionId: null } };
