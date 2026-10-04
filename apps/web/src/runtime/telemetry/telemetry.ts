import type { ClientError, ClientErrorCode } from '@repo/game-client-sdk/errors';
import type { PublicErrorCode } from '@repo/game-protocol/errors';

import type { ErrorContext, ErrorReporter } from '@/runtime/telemetry/error-policy';

export type Screen = 'entry' | 'loading' | 'lobby' | 'game' | 'result';
type ClientFailureFields = Readonly<{
  failure_kind?: ClientError['kind'];
  failure_code?: PublicErrorCode | ClientErrorCode;
}>;
export type ProductEvent =
  | Readonly<{ name: 'page_view'; screen: Screen }>
  | Readonly<{ name: 'bootstrap_result'; outcome: 'success' | 'failure'; duration_ms: number }>
  | (Readonly<{
      name: 'room_request';
      operation: 'create' | 'join' | 'cancel';
      phase: 'start' | 'success' | 'failure';
      duration_ms?: number;
    }> &
      ClientFailureFields)
  | Readonly<{
      name: 'waiting_result';
      outcome: 'matched' | 'cancelled' | 'expired';
      duration_ms: number;
    }>
  | Readonly<{ name: 'play_started'; entry: 'new' | 'resumed' }>
  | Readonly<{
      name: 'play_finished';
      entry: 'new' | 'resumed';
      reason: 'completed' | 'forfeit' | 'timeout' | 'other';
      outcome: 'win' | 'loss' | 'draw';
    }>
  | Readonly<{ name: 'recovery_started'; operation: 'reentry' | 'connection' }>
  | (Readonly<{
      name: 'recovery_result';
      operation: 'reentry' | 'connection';
      outcome: 'success' | 'failure' | 'cancelled';
      duration_ms: number;
    }> &
      ClientFailureFields);

export function clientFailureFields(error?: ClientError | null): ClientFailureFields {
  return error
    ? {
        failure_kind: error.kind,
        failure_code: error.kind === 'server' ? error.error.code : error.code,
      }
    : {};
}
export interface AnalyticsSink {
  send(event: ProductEvent): void;
}
export interface ErrorSink extends ErrorReporter {
  dispose(): void;
}
export interface Telemetry extends ErrorReporter {
  start(): Promise<void>;
  trackEvent(event: Exclude<ProductEvent, { name: 'page_view' }>): void;
  trackScreen(screen: Screen): void;
  dispose(): void;
}

export function createTelemetry(options: {
  analytics?: AnalyticsSink;
  errors?: ErrorSink;
}): Telemetry {
  const { analytics } = options;
  let { errors } = options;
  let started = false;
  let disposed = false;
  let visibleScreen: Screen | null = null;
  const safe = (callback: () => void) => {
    try {
      callback();
    } catch {
      /* Telemetry never owns gameplay. */
    }
  };
  const emit = (event: ProductEvent) => {
    if (disposed || !started) return;
    safe(() => analytics?.send(event));
  };
  return {
    async start() {
      if (started || disposed) return;
      started = true;
    },
    trackEvent: emit,
    trackScreen(screen: Screen) {
      if (visibleScreen === screen) return;
      visibleScreen = screen;
      emit({ name: 'page_view', screen });
    },
    reportUnexpected(error: unknown, context?: ErrorContext) {
      if (disposed) return;
      safe(() => errors?.reportUnexpected(error, context));
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const sink = errors;
      errors = undefined;
      safe(() => sink?.dispose());
    },
  };
}

export const inactiveTelemetry: Telemetry = {
  async start() {},
  trackEvent() {},
  trackScreen() {},
  reportUnexpected() {},
  dispose() {},
};
