export type AcknowledgementResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly reason: 'timeout' | 'aborted' };

export function waitForAcknowledgement(
  emit: (acknowledge: (value: unknown) => void) => void,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<AcknowledgementResult> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs;
    let settled = false;
    let finish: (result: AcknowledgementResult) => void = () => {};
    const timeout = setTimeout(() => {
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);
    const onAbort = (): void => finish({ ok: false, reason: 'aborted' });
    finish = (result: AcknowledgementResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const acknowledge = (value: unknown): void => {
      finish(
        performance.now() >= deadline ? { ok: false, reason: 'timeout' } : { ok: true, value },
      );
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    try {
      emit(acknowledge);
    } catch {
      finish({ ok: false, reason: 'timeout' });
    }
  });
}
