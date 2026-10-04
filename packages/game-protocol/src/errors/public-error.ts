import { PUBLIC_ERROR_CODE, type PublicErrorCode } from './constants';

type EmptyParams = Readonly<Record<string, never>>;

export type ErrorParamsByCode = {
  readonly [Code in Exclude<PublicErrorCode, typeof PUBLIC_ERROR_CODE.RATE_LIMITED>]: EmptyParams;
} & {
  readonly [PUBLIC_ERROR_CODE.RATE_LIMITED]: { readonly retryAfterMs: number };
};

export type PublicError = {
  readonly [Code in PublicErrorCode]: {
    readonly code: Code;
    readonly params: ErrorParamsByCode[Code];
  };
}[PublicErrorCode];

export type ProtocolResult<Value> =
  { readonly ok: true; readonly data: Value } | { readonly ok: false; readonly error: PublicError };

type EmptyErrorCode = Exclude<PublicErrorCode, typeof PUBLIC_ERROR_CODE.RATE_LIMITED>;
type RateLimitedError = Extract<PublicError, { code: typeof PUBLIC_ERROR_CODE.RATE_LIMITED }>;

export function createPublicError<Code extends EmptyErrorCode>(
  code: Code,
  params: ErrorParamsByCode[Code],
): Extract<PublicError, { readonly code: Code }>;
export function createPublicError(
  code: typeof PUBLIC_ERROR_CODE.RATE_LIMITED,
  params: RateLimitedError['params'],
): RateLimitedError;
export function createPublicError(
  ...[code, params]:
    | [code: EmptyErrorCode, params: ErrorParamsByCode[EmptyErrorCode]]
    | [code: typeof PUBLIC_ERROR_CODE.RATE_LIMITED, params: RateLimitedError['params']]
): PublicError {
  if (code === PUBLIC_ERROR_CODE.RATE_LIMITED) return { code, params };
  return { code, params };
}
