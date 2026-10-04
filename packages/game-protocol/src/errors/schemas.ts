import * as v from 'valibot';

import { PUBLIC_ERROR_CODE, type PublicErrorCode } from './constants';

const emptyParamsSchema = v.strictObject({});
const emptyError = (code: Exclude<PublicErrorCode, typeof PUBLIC_ERROR_CODE.RATE_LIMITED>) =>
  v.strictObject({ code: v.literal(code), params: emptyParamsSchema });

export const publicErrorSchema = v.union([
  emptyError(PUBLIC_ERROR_CODE.INVALID_REQUEST),
  emptyError(PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH),
  emptyError(PUBLIC_ERROR_CODE.ROOM_NOT_FOUND),
  emptyError(PUBLIC_ERROR_CODE.ROOM_NOT_JOINABLE),
  emptyError(PUBLIC_ERROR_CODE.ROOM_ALREADY_MATCHED),
  emptyError(PUBLIC_ERROR_CODE.ROOM_CODE_EXHAUSTED),
  emptyError(PUBLIC_ERROR_CODE.INVALID_AUTHORITY),
  emptyError(PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE),
  emptyError(PUBLIC_ERROR_CODE.SESSION_REPLACED),
  emptyError(PUBLIC_ERROR_CODE.NOT_YOUR_TURN),
  emptyError(PUBLIC_ERROR_CODE.STALE_TURN),
  emptyError(PUBLIC_ERROR_CODE.TURN_EXPIRED),
  emptyError(PUBLIC_ERROR_CODE.ROLL_LIMIT_REACHED),
  emptyError(PUBLIC_ERROR_CODE.NO_DICE_TO_ROLL),
  emptyError(PUBLIC_ERROR_CODE.HOLD_NOT_ALLOWED),
  emptyError(PUBLIC_ERROR_CODE.CATEGORY_ALREADY_RECORDED),
  emptyError(PUBLIC_ERROR_CODE.INVALID_CATEGORY),
  emptyError(PUBLIC_ERROR_CODE.MATCH_FINISHED),
  emptyError(PUBLIC_ERROR_CODE.ACTION_ID_REUSED),
  emptyError(PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED),
  v.strictObject({
    code: v.literal(PUBLIC_ERROR_CODE.RATE_LIMITED),
    params: v.strictObject({
      retryAfterMs: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(0)),
    }),
  }),
  emptyError(PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE),
  emptyError(PUBLIC_ERROR_CODE.INTERNAL_ERROR),
]);
