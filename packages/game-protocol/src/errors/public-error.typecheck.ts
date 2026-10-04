import { createPublicError, PUBLIC_ERROR_CODE, type PublicErrorCode } from './index';

export const limited = createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 });
export const { retryAfterMs }: { retryAfterMs: number } = limited.params;
export const empty = createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {});
// @ts-expect-error RATE_LIMITED needs its delay even for a literal code.
createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, {});
// @ts-expect-error Empty params codes cannot carry a delay.
createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, { retryAfterMs: 1_000 });

export function checkUncorrelatedCode(code: PublicErrorCode) {
  // @ts-expect-error An arbitrary code may require params; {} cannot prove their correlation.
  createPublicError(code, {});
  // @ts-expect-error An arbitrary code may forbid params; a delay cannot prove correlation either.
  createPublicError(code, { retryAfterMs: 1_000 });
}
