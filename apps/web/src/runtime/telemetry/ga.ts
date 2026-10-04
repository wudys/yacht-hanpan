import { CLIENT_ERROR_CODE } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';

import type { AnalyticsSink, ProductEvent, Screen } from '@/runtime/telemetry/telemetry';

const FAILURE_CODES = new Set<string>([
  ...Object.values(PUBLIC_ERROR_CODE),
  ...Object.values(CLIENT_ERROR_CODE),
]);

// The HTML head owns initialization; this adapter updates virtual pages and sends product events.
export function createGoogleAnalytics(measurementId: string, origin: string): AnalyticsSink {
  const host = window as unknown as { hanpanGtag?: (...args: unknown[]) => void };
  let screen: Screen | null = null;
  let referrer = '';
  return {
    send(event: ProductEvent) {
      if (event.name === 'page_view') {
        referrer = screen === null ? '' : `${origin}/${screen}`;
        screen = event.screen;
      }
      const page = {
        page_location: `${origin}/${screen ?? 'entry'}`,
        page_title: `Yacht Hanpan · ${screen ?? 'entry'}`,
        page_referrer: referrer,
      };
      if (event.name === 'page_view')
        host.hanpanGtag?.('config', measurementId, {
          update: true,
          send_page_view: false,
          ...page,
        });
      host.hanpanGtag?.('event', event.name, {
        ...eventParameters(event),
        send_to: measurementId,
        ...page,
      });
    },
  };
}

// Project each event at the outbound boundary; TypeScript does not strip extra properties.
function eventParameters(event: ProductEvent): Record<string, string | number> {
  switch (event.name) {
    case 'page_view':
      return { screen: event.screen };
    case 'bootstrap_result':
      return { outcome: event.outcome, duration_ms: event.duration_ms };
    case 'room_request':
      return {
        operation: event.operation,
        phase: event.phase,
        ...(event.duration_ms === undefined ? {} : { duration_ms: event.duration_ms }),
        ...(event.phase === 'failure' ? failureParameters(event) : {}),
      };
    case 'waiting_result':
      return { outcome: event.outcome, duration_ms: event.duration_ms };
    case 'play_started':
      return { entry: event.entry };
    case 'play_finished':
      return { entry: event.entry, reason: event.reason, outcome: event.outcome };
    case 'recovery_started':
      return { operation: event.operation };
    case 'recovery_result':
      return {
        operation: event.operation,
        outcome: event.outcome,
        duration_ms: event.duration_ms,
        ...(event.outcome === 'failure' ? failureParameters(event) : {}),
      };
  }
}

function failureParameters(
  event: Extract<ProductEvent, { name: 'room_request' | 'recovery_result' }>,
): Record<string, string> {
  if (
    !event.failure_kind ||
    !['server', 'transport', 'protocol'].includes(event.failure_kind) ||
    !event.failure_code ||
    !FAILURE_CODES.has(event.failure_code)
  )
    return {};
  return { failure_kind: event.failure_kind, failure_code: event.failure_code };
}
