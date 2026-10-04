import { PUBLIC_ERROR_CODE } from './constants';
import type { ErrorParamsByCode, PublicError } from './public-error';

export const empty: ErrorParamsByCode['INTERNAL_ERROR'] = {};
export const limited: PublicError = {
  code: PUBLIC_ERROR_CODE.RATE_LIMITED,
  params: { retryAfterMs: 1_000 },
};
// @ts-expect-error Empty wire params must reject unexpected fields.
export const extra: ErrorParamsByCode['INTERNAL_ERROR'] = { privateDetail: 'hidden' };
// @ts-expect-error Empty wire params must be an object, not a primitive.
export const primitive: ErrorParamsByCode['INTERNAL_ERROR'] = 1;
const fields = { retryAfterMs: 1_000 };
// @ts-expect-error Non-literal objects must not bypass the empty params contract.
export const extraVariable: PublicError = {
  code: PUBLIC_ERROR_CODE.INTERNAL_ERROR,
  params: fields,
};
// @ts-expect-error Parameterized codes must carry their required params.
export const missing: PublicError = { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: {} };
