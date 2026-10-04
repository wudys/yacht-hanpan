/** Display-only estimate. Never authorizes a server command or outcome. */
export interface ServerClock {
  readonly beginSample: () => Readonly<{ order: number; sentAt: number }>;
  readonly acceptSample: (
    sample: Readonly<{ order: number; sentAt: number }>,
    serverTime: number,
  ) => void;
  readonly now: () => number | null;
}

export function createServerClock(
  monotonicNow: () => number = () => performance.now(),
): ServerClock {
  let order = 0;
  let acceptedOrder = 0;
  let anchor: { serverTime: number; receivedAt: number } | null = null;
  return {
    beginSample: () => ({ order: ++order, sentAt: monotonicNow() }),
    acceptSample(sample: Readonly<{ order: number; sentAt: number }>, serverTime: number) {
      const receivedAt = monotonicNow();
      if (sample.order <= acceptedOrder || !Number.isSafeInteger(serverTime) || serverTime < 0)
        return;
      acceptedOrder = sample.order;
      anchor = { serverTime: serverTime + Math.max(0, receivedAt - sample.sentAt) / 2, receivedAt };
    },
    now: () =>
      anchor === null ? null : anchor.serverTime + Math.max(0, monotonicNow() - anchor.receivedAt),
  };
}
