import { isServerReadyPayload, SERVER_READINESS_PATH } from '@repo/game-protocol/http';

const OVERALL_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 2_000;

export type ServerReadinessResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'cancelled' | 'unavailable' | 'incompatible' | 'invalid-response';
    };

export interface ServerReadiness {
  wait(signal?: AbortSignal): Promise<ServerReadinessResult>;
}

type AttemptResult = 'ready' | 'retry' | 'cancelled' | 'incompatible' | 'invalid-response';

export function createServerReadiness(
  serverUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): ServerReadiness {
  const readinessUrl = new URL(SERVER_READINESS_PATH, serverUrl).toString();

  return {
    async wait(signal?: AbortSignal): Promise<ServerReadinessResult> {
      if (signal?.aborted) return { ok: false, reason: 'cancelled' };
      const operation = new AbortController();
      const cancel = (): void => operation.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const deadline = performance.now() + OVERALL_TIMEOUT_MS;

      try {
        while (!operation.signal.aborted) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) return { ok: false, reason: 'unavailable' };
          const result = await requestReadiness(
            readinessUrl,
            fetchImpl,
            Math.min(REQUEST_TIMEOUT_MS, remaining),
            operation.signal,
          );
          if (result === 'ready') return { ok: true };
          if (result === 'incompatible' || result === 'invalid-response')
            return { ok: false, reason: result };
          if (result === 'cancelled') return { ok: false, reason: 'cancelled' };

          const retryRemaining = deadline - performance.now();
          if (retryRemaining <= 0) return { ok: false, reason: 'unavailable' };
          const retry = await waitForRetry(
            Math.min(RETRY_INTERVAL_MS, retryRemaining),
            operation.signal,
          );
          if (!retry) return { ok: false, reason: 'cancelled' };
        }
        return { ok: false, reason: 'cancelled' };
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
  };
}

async function requestReadiness(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<AttemptResult> {
  if (signal.aborted) return 'cancelled';
  const request = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let cancelRequest: (() => void) | undefined;

  const response = Promise.resolve()
    .then(() =>
      fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: request.signal,
      }),
    )
    .then(classifyResponse, () => (signal.aborted ? 'cancelled' : 'retry') as AttemptResult);
  const timedOut = new Promise<AttemptResult>((resolve) => {
    timeout = setTimeout(() => {
      request.abort();
      resolve('retry');
    }, timeoutMs);
  });
  const cancelled = new Promise<AttemptResult>((resolve) => {
    cancelRequest = (): void => {
      request.abort();
      resolve('cancelled');
    };
    signal.addEventListener('abort', cancelRequest, { once: true });
  });

  try {
    return await Promise.race([response, timedOut, cancelled]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    if (cancelRequest !== undefined) signal.removeEventListener('abort', cancelRequest);
  }
}

async function classifyResponse(response: Response): Promise<AttemptResult> {
  if (response.status >= 500 || response.status === 408 || response.status === 429) return 'retry';
  if (response.status !== 200) return 'incompatible';
  try {
    const body: unknown = await response.json();
    return isServerReadyPayload(body) ? 'ready' : 'invalid-response';
  } catch (error) {
    return error instanceof SyntaxError ? 'invalid-response' : 'retry';
  }
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const cancel = (): void => {
      if (timeout !== null) clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      resolve(false);
    };
    signal.addEventListener('abort', cancel, { once: true });
    timeout = setTimeout(() => {
      signal.removeEventListener('abort', cancel);
      resolve(true);
    }, delayMs);
  });
}
