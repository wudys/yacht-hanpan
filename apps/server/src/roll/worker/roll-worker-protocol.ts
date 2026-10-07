import {
  isRollCandidateEvaluation,
  type RollCandidateEvaluation,
  type SimulationInput,
} from '@repo/dice-simulation/contract';

export interface RollWorkerRequest {
  readonly kind: 'run';
  readonly id: number;
  readonly input: SimulationInput;
}

interface RollWorkerError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: RollWorkerError;
}

// Match the SDK's linked Error cause depth without transporting arbitrary properties.
const MAX_ERROR_CAUSE_DEPTH = 5;

export type RollWorkerResponse =
  | { readonly kind: 'ready'; readonly goldenDigest: string }
  | { readonly kind: 'result'; readonly id: number; readonly result: RollCandidateEvaluation }
  | { readonly kind: 'error'; readonly id: number; readonly error: RollWorkerError }
  | { readonly kind: 'startup-error'; readonly error: RollWorkerError };

export function serializeRollWorkerError(value: unknown): RollWorkerError {
  const error = value instanceof Error ? value : new Error('Roll worker failed');
  return serializeError(error, 0);
}

function serializeError(error: Error, depth: number): RollWorkerError {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(depth < MAX_ERROR_CAUSE_DEPTH && error.cause instanceof Error
      ? { cause: serializeError(error.cause, depth + 1) }
      : {}),
  };
}

export function restoreRollWorkerError(value: RollWorkerError): Error {
  const error = new Error(value.message, {
    ...(value.cause === undefined ? {} : { cause: restoreRollWorkerError(value.cause) }),
  });
  error.name = value.name;
  if (value.stack === undefined) delete error.stack;
  else error.stack = value.stack;
  return error;
}

export function parseRollWorkerResponse(value: unknown): RollWorkerResponse {
  if (!isRecord(value) || typeof value.kind !== 'string') throw invalidResponse();
  if (value.kind === 'ready') {
    if (!hasExactKeys(value, ['goldenDigest', 'kind']) || typeof value.goldenDigest !== 'string') {
      throw invalidResponse();
    }
    return { kind: 'ready', goldenDigest: value.goldenDigest };
  }
  if (value.kind === 'startup-error') {
    if (!hasExactKeys(value, ['error', 'kind'])) throw invalidResponse();
    return { kind: 'startup-error', error: parseRollWorkerError(value.error) };
  }
  if (value.kind === 'error') {
    if (!hasExactKeys(value, ['error', 'id', 'kind']) || !isJobId(value.id))
      throw invalidResponse();
    return { kind: 'error', id: value.id, error: parseRollWorkerError(value.error) };
  }
  if (value.kind === 'result') {
    if (
      !hasExactKeys(value, ['id', 'kind', 'result']) ||
      !isJobId(value.id) ||
      !isRollCandidateEvaluation(value.result)
    ) {
      throw invalidResponse();
    }
    return { kind: 'result', id: value.id, result: value.result };
  }
  throw invalidResponse();
}

function parseRollWorkerError(value: unknown, depth: number = 0): RollWorkerError {
  if (
    !isRecord(value) ||
    depth > MAX_ERROR_CAUSE_DEPTH ||
    typeof value.name !== 'string' ||
    typeof value.message !== 'string' ||
    ('stack' in value && typeof value.stack !== 'string') ||
    !hasExactKeys(value, [
      'message',
      'name',
      ...('stack' in value ? ['stack'] : []),
      ...('cause' in value ? ['cause'] : []),
    ])
  ) {
    throw invalidResponse();
  }
  return {
    name: value.name,
    message: value.message,
    ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
    ...('cause' in value ? { cause: parseRollWorkerError(value.cause, depth + 1) } : {}),
  };
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function isJobId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidResponse(): Error {
  return new Error('Invalid roll worker response');
}
