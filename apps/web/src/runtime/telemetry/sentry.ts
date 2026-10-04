import productRelease from '@repo/product-release';
import {
  captureException,
  defaultStackParser,
  type ErrorEvent,
  getClient,
  getCurrentScope,
  globalHandlersIntegration,
  init,
  linkedErrorsIntegration,
  makeFetchTransport,
} from '@sentry/react';

import { ERROR_CONTEXT_VALUES, type ErrorContext } from '@/runtime/telemetry/error-policy';
import type { ErrorSink } from '@/runtime/telemetry/telemetry';

// Fixed product/native names and SDK mechanisms are structure, not an admission rule. Unknown
// free text is redacted, while the original exception and its own code positions remain.
const SAFE_ERROR_NAME =
  /^(?:React ErrorBoundary )?(?:Error|TypeError|RangeError|ReferenceError|SyntaxError|EvalError|URIError|AggregateError|DOMException|AbortError|TimeoutError|NetworkError|EncodingError|SecurityError|NotAllowedError|NotSupportedError|InvalidStateError|UnhandledRejection|CompileError|LinkError|RuntimeError|WebConfigError|GameApiParseError|RapierInitializationError|ReplayCanonicalizationError|SimulationInputError)$/u;
const MECHANISMS = new Set([
  'generic',
  'chained',
  'auto.core.linked_errors',
  'auto.function.react.error_handler',
  'auto.browser.global_handlers.onerror',
  'auto.browser.global_handlers.onunhandledrejection',
]);

// Reconstruct after SDK processing so automatic and manual captures have the same
// private-data boundary. Preserve cause ordering/relationships and handledness.
export function sanitizeErrorEvent(
  event: ErrorEvent,
  origin: string,
  release: string,
): ErrorEvent | null {
  const originals = event.exception?.values ?? [];
  if (originals.length === 0) return null;
  const context: Record<string, string> = {};
  for (const [key, values] of Object.entries(ERROR_CONTEXT_VALUES)) {
    const value = event.tags?.[key];
    if (typeof value === 'string' && (values as readonly string[]).includes(value))
      context[key] = value;
  }
  const exceptions = originals.map((exception) => {
    const frames = (exception.stacktrace?.frames ?? []).flatMap((frame) => {
      try {
        const url = new URL(frame.filename ?? '');
        if (url.origin !== origin || !/^\/assets\/[\w.-]+\.js$/u.test(url.pathname)) return [];
        return [
          {
            filename: `${origin}${url.pathname}`,
            lineno: frame.lineno,
            colno: frame.colno,
            in_app: true,
          },
        ];
      } catch {
        return [];
      }
    });
    const { mechanism } = exception;
    return {
      type: SAFE_ERROR_NAME.test(exception.type ?? '') ? exception.type : 'Error',
      value: '[redacted]',
      ...(frames.length ? { stacktrace: { frames } } : {}),
      ...(mechanism
        ? {
            mechanism: {
              type: MECHANISMS.has(mechanism.type) ? mechanism.type : 'generic',
              ...(typeof mechanism.handled === 'boolean' ? { handled: mechanism.handled } : {}),
              ...(typeof mechanism.is_exception_group === 'boolean'
                ? { is_exception_group: mechanism.is_exception_group }
                : {}),
              ...(Number.isInteger(mechanism.exception_id)
                ? { exception_id: mechanism.exception_id }
                : {}),
              ...(Number.isInteger(mechanism.parent_id) ? { parent_id: mechanism.parent_id } : {}),
              ...(mechanism.source === 'cause' || /^errors\[\d+\]$/u.test(mechanism.source ?? '')
                ? { source: mechanism.source }
                : {}),
            },
          }
        : {}),
    };
  });
  const frames = exceptions.flatMap((exception) => exception.stacktrace?.frames ?? []);
  if (originals.some((exception) => exception.stacktrace?.frames?.length) && frames.length === 0)
    return null;
  const images = (event.debug_meta?.images ?? []).flatMap((image) => {
    if (
      image.type !== 'sourcemap' ||
      !image.code_file ||
      !image.debug_id ||
      !/^[a-f0-9-]{36}$/iu.test(image.debug_id)
    )
      return [];
    try {
      const url = new URL(image.code_file);
      const codeFile = `${url.origin}${url.pathname}`;
      return frames.some((frame) => frame.filename === codeFile)
        ? [{ type: 'sourcemap' as const, code_file: codeFile, debug_id: image.debug_id }]
        : [];
    } catch {
      return [];
    }
  });
  return {
    ...(images.length ? { debug_meta: { images } } : {}),
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: 'javascript',
    level: 'error',
    environment: 'production',
    release,
    tags: { app_version: productRelease.version, ...context },
    exception: { values: exceptions },
  };
}

export function createSentryErrors(dsn: string, origin: string, release: string): ErrorSink {
  const client = init({
    dsn,
    release,
    environment: 'production',
    defaultIntegrations: false,
    // Global handlers preserve the uncaught mechanism before LinkedErrors adds
    // causes. BrowserApiErrors in SDK 11 applies it to the first linked cause.
    integrations: [globalHandlersIntegration(), linkedErrorsIntegration()],
    transport: makeFetchTransport,
    transportOptions: { fetchOptions: { referrerPolicy: 'no-referrer', credentials: 'omit' } },
    stackParser: defaultStackParser,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    sendClientReports: false,
    beforeSend: (event) => sanitizeErrorEvent(event, origin, release),
  });
  let disposed = false;
  return {
    reportUnexpected(error: unknown, context?: ErrorContext) {
      if (!disposed && client) captureException(error, { captureContext: { tags: context } });
    },
    dispose() {
      if (disposed || !client) return;
      disposed = true;
      if (getClient() === client) getCurrentScope().setClient(undefined);
      try {
        void Promise.resolve(client.close(1000)).catch(() => undefined);
      } catch {
        /* Closing diagnostics never delays or interrupts product disposal. */
      }
    },
  };
}
