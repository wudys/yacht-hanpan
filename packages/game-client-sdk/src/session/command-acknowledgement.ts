import type { AcknowledgementResult } from '../socket/acknowledgement';
import type { RetryPolicy } from './retry-policy';

/** Retransmissions share one response deadline and every attempt's acknowledgement. */
export function waitForCommandAcknowledgement(
  emit: (acknowledge: (value: unknown) => void) => void,
  policy: RetryPolicy,
  signal?: AbortSignal,
): Promise<AcknowledgementResult> {
  return new Promise((resolve) => {
    const deadline = performance.now() + policy.commandResponseTimeoutMs;
    let attempts = 0;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finish: (result: AcknowledgementResult) => void = () => {};
    const onAbort = (): void => finish({ ok: false, reason: 'aborted' });
    finish = (result: AcknowledgementResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const acknowledge = (value: unknown): void => {
      if (performance.now() >= deadline) finish({ ok: false, reason: 'timeout' });
      else finish({ ok: true, value });
    };
    const advance = (): void => {
      if (settled) return;
      if (performance.now() >= deadline) {
        finish({ ok: false, reason: 'timeout' });
        return;
      }
      if (attempts < policy.maximumAttempts) {
        attempts += 1;
        try {
          emit(acknowledge);
        } catch {
          // A transport exception does not establish whether the server received the intent.
        }
      }
      if (settled) return;
      const remaining = deadline - performance.now();
      timer = setTimeout(
        advance,
        attempts < policy.maximumAttempts ? Math.min(policy.retryIntervalMs, remaining) : remaining,
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else advance();
  });
}
