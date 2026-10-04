import { afterEach, describe, expect, test, vi } from 'vitest';

import { createServerReadiness } from '@/runtime/network/server-readiness';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createServerReadiness', () => {
  test('stays idle until wait and accepts the Bun readiness payload', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse(200, { ok: true, runtime: 'bun', release: 'ignored' }),
    );
    const readiness = createServerReadiness('https://game.example/base', fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(readiness.wait()).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://game.example/health/ready');
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  test('retries network, server, timeout, and rate-limit failures two seconds apart', async () => {
    vi.useFakeTimers();
    const outcomes: (() => Promise<Response>)[] = [
      async () => Promise.reject(new TypeError('offline')),
      async () => jsonResponse(500, { ok: false }),
      async () => jsonResponse(408, { ok: false }),
      async () => jsonResponse(429, { ok: false }),
      async () => jsonResponse(503, { ok: false, runtime: 'bun' }),
      async () => jsonResponse(200, { ok: true, runtime: 'bun' }),
    ];
    const fetchImpl = vi.fn(() => outcomes.shift()!());
    const waiting = createServerReadiness('https://game.example', fetchImpl).wait();

    await vi.advanceTimersByTimeAsync(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    for (let attempts = 2; attempts <= 6; attempts += 1) {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(fetchImpl).toHaveBeenCalledTimes(attempts - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchImpl).toHaveBeenCalledTimes(attempts);
    }

    await expect(waiting).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });

  test.each([400, 401, 403, 404])('treats HTTP %s as permanently incompatible', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, { ok: false }));

    await expect(createServerReadiness('https://game.example', fetchImpl).wait()).resolves.toEqual({
      ok: false,
      reason: 'incompatible',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([{ ok: false, runtime: 'bun' }, { ok: true, runtime: 'node' }, { runtime: 'bun' }])(
    'rejects an invalid successful readiness payload: %o',
    async (payload) => {
      const fetchImpl = vi.fn(async () => jsonResponse(200, payload));

      await expect(
        createServerReadiness('https://game.example', fetchImpl).wait(),
      ).resolves.toEqual({
        ok: false,
        reason: 'invalid-response',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  test('returns invalid-response when a successful response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('not json', { status: 200 }));

    await expect(createServerReadiness('https://game.example', fetchImpl).wait()).resolves.toEqual({
      ok: false,
      reason: 'invalid-response',
    });
  });

  test.each([0, -60_000, 60_000])(
    'keeps the overall timeout when fetch ignores abort and the wall clock shifts by %s ms',
    async (clockShiftMs) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
      const requestSignals: AbortSignal[] = [];
      const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignals.push(init!.signal as AbortSignal);
        return new Promise<Response>(() => undefined);
      });
      const waiting = createServerReadiness('https://game.example', fetchImpl).wait();

      let finished = false;
      void waiting.then(() => {
        finished = true;
      });
      await vi.advanceTimersByTimeAsync(4_000);
      vi.setSystemTime(Date.now() + clockShiftMs);
      await vi.advanceTimersByTimeAsync(15_999);
      expect(finished).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(finished).toBe(true);

      await expect(waiting).resolves.toEqual({ ok: false, reason: 'unavailable' });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(requestSignals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  test('cancels an active request and removes the external abort listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const removeEventListener = vi.spyOn(controller.signal, 'removeEventListener');
    let requestSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestSignal = init!.signal as AbortSignal;
      return new Promise<Response>(() => undefined);
    });
    const waiting = createServerReadiness('https://game.example', fetchImpl).wait(
      controller.signal,
    );
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();

    await expect(waiting).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(requestSignal?.aborted).toBe(true);
    expect(removeEventListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  test('ignores a response that arrives after its request timeout', async () => {
    vi.useFakeTimers();
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchImpl = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, runtime: 'bun' }));
    const waiting = createServerReadiness('https://game.example', fetchImpl).wait();

    await vi.advanceTimersByTimeAsync(7_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(waiting).resolves.toEqual({ ok: true });

    resolveFirst(jsonResponse(200, { ok: true, runtime: 'node' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('retries a connection lost while reading the readiness body', async () => {
    vi.useFakeTimers();
    const interrupted = new Response(
      new ReadableStream({
        start(controller: ReadableStreamDefaultController<Uint8Array>) {
          controller.error(new TypeError('connection reset'));
        },
      }),
    );
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, runtime: 'bun' }));
    const waiting = createServerReadiness('https://game.example', fetchImpl).wait();

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(waiting).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
