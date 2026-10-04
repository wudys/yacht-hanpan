import { initializeDeterministicRapierForBun } from '@repo/dice-simulation/rapier/bun';
import { simulateRollOutcome } from '@repo/dice-simulation/simulate';
import { expect, test } from 'bun:test';

import { ROLL_WORKER_GOLDEN_DIGEST } from '@/roll/roll-worker-golden';
import {
  parseRollWorkerResponse,
  restoreRollWorkerError,
  serializeRollWorkerError,
} from '@/roll/roll-worker-protocol';

test('accepts only exact internal worker response envelopes', () => {
  expect(
    parseRollWorkerResponse({ kind: 'ready', goldenDigest: ROLL_WORKER_GOLDEN_DIGEST }),
  ).toEqual({ kind: 'ready', goldenDigest: ROLL_WORKER_GOLDEN_DIGEST });
  expect(() =>
    parseRollWorkerResponse({
      kind: 'ready',
      goldenDigest: ROLL_WORKER_GOLDEN_DIGEST,
      seed: 'must-not-leak',
    }),
  ).toThrow();
  expect(() => parseRollWorkerResponse({ kind: 'result', id: 0, result: {} })).toThrow();
  expect(() => parseRollWorkerResponse({ kind: 'result', id: 1, result: {} })).toThrow();
  expect(() => parseRollWorkerResponse({ kind: 'private-error', message: 'raw' })).toThrow();
});

test('rejects sparse outcomes preserved by worker structuredClone', async () => {
  await initializeDeterministicRapierForBun();
  const result = await simulateRollOutcome({
    rollId: 'worker-sparse-result',
    seed: 'worker-sparse-result',
    rolledSlots: [0],
    pourStyle: 'classic',
  });
  expect(parseRollWorkerResponse(structuredClone({ kind: 'result', id: 1, result }))).toEqual({
    kind: 'result',
    id: 1,
    result,
  });
  const malformed = structuredClone(result);
  Reflect.deleteProperty(malformed.authoritativeValuesBySlot, 0);
  const message = structuredClone({ kind: 'result', id: 1, result: malformed });
  expect(0 in message.result.authoritativeValuesBySlot).toBe(false);
  expect(() => parseRollWorkerResponse(message)).toThrow('Invalid roll worker response');
});

test('preserves Error names, mapped stacks and Error causes across worker IPC', () => {
  const cause = new RangeError('private cause');
  cause.stack = 'RangeError: private cause\n    at inner (/app/src/roll/worker.ts:12:3)';
  const error = new TypeError('private message', { cause });
  error.stack = 'TypeError: private message\n    at execute (/app/src/roll/worker.ts:24:5)';
  Object.assign(error, { seed: 'private seed', input: { credential: 'private credential' } });

  const payload = serializeRollWorkerError(error);
  expect(payload).toEqual({
    name: 'TypeError',
    message: error.message,
    stack: error.stack,
    cause: { name: 'RangeError', message: cause.message, stack: cause.stack },
  });
  const response = parseRollWorkerResponse(
    structuredClone({ kind: 'error', id: 1, error: payload }),
  );
  expect(response.kind).toBe('error');
  if (response.kind !== 'error') throw new Error('Expected worker error response');
  const restored = restoreRollWorkerError(response.error);
  expect(restored).toBeInstanceOf(Error);
  expect(restored.name).toBe(error.name);
  expect(restored.message).toBe(error.message);
  expect(restored.stack).toBe(error.stack);
  expect(restored.cause).toBeInstanceOf(Error);
  expect(restored.cause).toMatchObject({
    name: cause.name,
    message: cause.message,
    stack: cause.stack,
  });
  expect('seed' in restored).toBe(false);
  const withoutStack = new Error('no stack');
  delete withoutStack.stack;
  const noStackResponse = parseRollWorkerResponse({
    kind: 'startup-error',
    error: serializeRollWorkerError(withoutStack),
  });
  if (noStackResponse.kind !== 'startup-error') throw new Error('Expected worker startup error');
  expect(restoreRollWorkerError(noStackResponse.error).stack).toBeUndefined();
});

test('bounds causes to the SDK depth and excludes non-Error thrown values and causes', () => {
  let error = new Error('deepest');
  for (let index = 0; index < 8; index += 1) error = new Error(`depth ${index}`, { cause: error });
  let restored: unknown = restoreRollWorkerError(serializeRollWorkerError(error));
  let count = 0;
  while (restored instanceof Error) {
    count += 1;
    restored = restored.cause;
  }
  expect(count).toBe(6);
  const circular = new Error('cycle');
  circular.cause = circular;
  expect(() => structuredClone(serializeRollWorkerError(circular))).not.toThrow();
  const privateCause = serializeRollWorkerError(new Error('known', { cause: { seed: 'private' } }));
  expect(privateCause.cause).toBeUndefined();
  expect(serializeRollWorkerError({ message: 'private thrown value' })).toMatchObject({
    name: 'Error',
    message: 'Roll worker failed',
  });
});

test('accepts startup causes and rejects extra or malformed error payloads', () => {
  const error = serializeRollWorkerError(new Error('startup'));
  expect(parseRollWorkerResponse({ kind: 'startup-error', error })).toEqual({
    kind: 'startup-error',
    error,
  });
  for (const payload of [
    { kind: 'error', id: 1 },
    { kind: 'error', id: 1, error: { ...error, seed: 'private' } },
    { kind: 'error', id: 1, error: { ...error, stack: 42 } },
    { kind: 'error', id: 1, error: { ...error, cause: { input: 'private' } } },
    { kind: 'startup-error', error, id: 1 },
    { kind: 'startup-error', error: null },
  ]) {
    expect(() => parseRollWorkerResponse(payload)).toThrow('Invalid roll worker response');
  }
  let tooDeep = error;
  for (let index = 0; index < 6; index += 1) tooDeep = { ...error, cause: tooDeep };
  expect(() => parseRollWorkerResponse({ kind: 'startup-error', error: tooDeep })).toThrow();
});
