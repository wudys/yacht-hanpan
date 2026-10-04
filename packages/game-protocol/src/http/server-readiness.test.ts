import { describe, expect, test } from 'bun:test';

import { isServerReadyPayload, SERVER_READINESS_PATH } from './server-readiness';

describe('browser readiness contract', () => {
  test('keeps the endpoint used by deployment health checks', () => {
    expect(SERVER_READINESS_PATH).toBe('/health/ready');
  });

  test.each([
    { ok: true, runtime: 'bun' },
    { ok: true, runtime: 'bun', release: 'diagnostic-only' },
  ])('accepts ready responses with optional diagnostic fields: %j', (payload) => {
    expect(isServerReadyPayload(payload)).toBe(true);
  });

  test.each(
    [
      null,
      [],
      'ready',
      {},
      { ok: true },
      { runtime: 'bun' },
      { ok: false, runtime: 'bun' },
      { ok: 'true', runtime: 'bun' },
      { ok: true, runtime: 'node' },
    ].map((payload) => ({ payload })),
  )('rejects unavailable or incompatible payloads: %j', ({ payload }) => {
    expect(isServerReadyPayload(payload)).toBe(false);
  });
});
