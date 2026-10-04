// @vitest-environment jsdom
import productRelease from '@repo/product-release';
import { captureReactException, type ErrorEvent, getClient } from '@sentry/react';
import { Component, createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createReactErrorHandler } from '@/runtime/telemetry/react-errors';
import { createSentryErrors, sanitizeErrorEvent } from '@/runtime/telemetry/sentry';
import type { ErrorSink } from '@/runtime/telemetry/telemetry';

const origin = 'https://yacht.example.com';
const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response('{}', { status: 200 }));
const sinks = new Set<ErrorSink>();
beforeEach(() => {
  fetch.mockClear();
  vi.stubGlobal('fetch', fetch);
});
afterEach(async () => {
  for (const sink of sinks) sink.dispose();
  sinks.clear();
  await Promise.resolve();
  vi.unstubAllGlobals();
});
function collector() {
  const sink = createSentryErrors(
    'https://publickey@o1.ingest.sentry.io/1',
    origin,
    productRelease.version,
  );
  sinks.add(sink);
  return sink;
}
function failure(line: number, cause?: Error) {
  const error = new TypeError('PRIVATE', { cause });
  error.stack = `TypeError: PRIVATE\n    at run (${origin}/assets/app.js:${line}:2)`;
  return error;
}
function envelopes(): ErrorEvent[] {
  return fetch.mock.calls.map(
    ([, options]) => JSON.parse(String(options?.body).split('\n')[2] ?? '{}') as ErrorEvent,
  );
}

class TestErrorBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  public state: { failed: boolean } = { failed: false };
  public static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  public render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

function ThrowingView({ error }: { error: Error }): never {
  throw error;
}

it('initializes the active browser client with automatic error integrations', () => {
  collector();
  const integrations = getClient()
    ?.getOptions()
    .integrations.map(({ name }) => name);
  expect(integrations).toEqual(['GlobalHandlers', 'LinkedErrors']);
});

it('preserves the native global SDK mechanisms on the captured error and its cause', async () => {
  const errors = collector();
  const cause = new RangeError('PRIVATE');
  cause.stack = `RangeError: PRIVATE\n    at cause (${origin}/assets/cause.js:7:8)`;
  const error = failure(8, cause);
  // Exercise the SDK's installed handlers; native dispatch is verified in Chromium.
  window.onerror?.('PRIVATE', `${origin}/assets/app.js`, 8, 2, error);
  const rejection = Object.assign(new Event('unhandledrejection'), {
    reason: failure(9),
    promise: Promise.resolve(),
  });
  window.onunhandledrejection?.(rejection);
  errors.reportUnexpected(error);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  const events = envelopes();
  expect(events[0]?.exception?.values).toMatchObject([
    { type: 'RangeError', mechanism: { type: 'chained', source: 'cause', handled: true } },
    {
      type: 'TypeError',
      mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false },
    },
  ]);
  expect(events[1]?.exception?.values?.[0]?.mechanism).toMatchObject({
    type: 'auto.browser.global_handlers.onunhandledrejection',
    handled: false,
  });
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
});

it('captures a React cause chain once across the root and Canvas reports', async () => {
  const errors = collector();
  const error = failure(5, failure(6));
  captureReactException(
    error,
    { componentStack: `\n    at PRIVATE (${origin}/assets/component.js?PRIVATE:7:8)` },
    { mechanism: { handled: true, type: 'auto.function.react.error_handler' } },
  );
  errors.reportUnexpected(error, { stage: 'canvas' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  expect(envelopes()[0]?.exception?.values).toMatchObject([
    { type: 'React ErrorBoundary TypeError' },
    { type: 'TypeError', mechanism: { source: 'cause' } },
    { type: 'TypeError', mechanism: { handled: true, type: 'auto.function.react.error_handler' } },
  ]);
  expect(JSON.stringify(envelopes())).not.toContain('PRIVATE');
});

it.each([true, false])(
  'the actual React root preserves handled=%s, the original cause and identity through the shared filter',
  async (handled) => {
    const errors = collector();
    const error = failure(5, failure(6));
    const root = createRoot(document.createElement('div'), {
      onCaughtError: (rootError, errorInfo) => {
        createReactErrorHandler(true)(rootError, errorInfo);
        errors.reportUnexpected(error, { stage: 'canvas' });
      },
      onUncaughtError: (rootError, errorInfo) => {
        createReactErrorHandler(false)(rootError, errorInfo);
        errors.reportUnexpected(error, { stage: 'canvas' });
      },
    });
    try {
      const throwingView = createElement(ThrowingView, { error });
      root.render(handled ? createElement(TestErrorBoundary, null, throwingView) : throwingView);
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const event = envelopes()[0];
      expect(event?.exception?.values).toMatchObject([
        { type: 'React ErrorBoundary TypeError' },
        { type: 'TypeError', mechanism: { source: 'cause' } },
        {
          type: 'TypeError',
          mechanism: { handled, type: 'auto.function.react.error_handler' },
          stacktrace: { frames: [{ filename: `${origin}/assets/app.js`, lineno: 5, colno: 2 }] },
        },
      ]);
      expect(event?.tags).toEqual({ stage: 'react', app_version: productRelease.version });
      expect(JSON.stringify(event)).not.toContain('PRIVATE');
      expect(event?.user).toBeUndefined();
      expect(event?.breadcrumbs).toBeUndefined();
      expect(event?.fingerprint).toBeUndefined();
      expect(fetch).toHaveBeenCalledOnce();
    } finally {
      root.unmount();
    }
  },
);

it('releases the active client and closes once with a bounded SDK timeout despite rejection', async () => {
  const errors = collector();
  const client = getClient();
  if (!client) throw new Error('Expected initialized client');
  const close = vi.spyOn(client, 'close').mockRejectedValue(new Error('SDK close failed'));
  expect(() => {
    errors.dispose();
    errors.dispose();
    errors.reportUnexpected(failure(1));
  }).not.toThrow();
  await Promise.resolve();
  expect(close).toHaveBeenCalledExactlyOnceWith(1000);
  expect(getClient()).toBeUndefined();
  expect(fetch).not.toHaveBeenCalled();
});

it('isolates an actual transport rejection from reporting another occurrence', async () => {
  fetch.mockRejectedValueOnce(new TypeError('network failed'));
  const errors = collector();
  errors.reportUnexpected(failure(8));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  errors.reportUnexpected(failure(9));
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(envelopes()).toHaveLength(2);
});

it('preserves native exceptions, cause relationships and handledness without private data', () => {
  const event: ErrorEvent = {
    type: undefined,
    tags: { stage: 'react', clientId: 'SECRET', failure_code: 'SECRET' },
    message: 'SECRET',
    user: { id: 'SECRET' },
    request: { url: `${origin}/?token=SECRET` },
    extra: { seatToken: 'SECRET' },
    breadcrumbs: [{ message: 'SECRET' }],
    contexts: { trace: { trace_id: 'SECRET', span_id: 'SECRET' } },
    fingerprint: ['SECRET'],
    exception: {
      values: [
        {
          type: 'RangeError',
          value: 'SECRET',
          mechanism: {
            type: 'chained',
            handled: true,
            source: 'cause',
            exception_id: 1,
            parent_id: 0,
            data: { token: 'SECRET' },
          },
          stacktrace: {
            frames: [
              {
                filename: `${origin}/assets/cause.js?token=SECRET`,
                lineno: 7,
                colno: 8,
                vars: { token: 'SECRET' },
              },
            ],
          },
        },
        {
          type: 'TypeError',
          value: 'SECRET',
          mechanism: {
            type: 'auto.browser.global_handlers.onerror',
            handled: false,
            exception_id: 0,
            ...{ description: 'SECRET' },
          },
          stacktrace: {
            frames: [
              { filename: `${origin}/assets/app.js?token=SECRET`, lineno: 2, colno: 3 },
              { filename: 'https://external.example.com/script.js' },
            ],
          },
        },
      ],
    },
    debug_meta: {
      images: [
        {
          type: 'sourcemap',
          code_file: `${origin}/assets/app.js?token=SECRET`,
          debug_id: '00000000-0000-4000-8000-000000000001',
        },
      ],
    },
  };
  const safe = sanitizeErrorEvent(event, origin, 'release-1');
  expect(safe?.exception?.values).toMatchObject([
    {
      type: 'RangeError',
      mechanism: { type: 'chained', handled: true, source: 'cause', exception_id: 1, parent_id: 0 },
      stacktrace: { frames: [{ filename: `${origin}/assets/cause.js`, lineno: 7, colno: 8 }] },
    },
    {
      type: 'TypeError',
      mechanism: { type: 'auto.browser.global_handlers.onerror', handled: false, exception_id: 0 },
      stacktrace: { frames: [{ filename: `${origin}/assets/app.js`, lineno: 2, colno: 3 }] },
    },
  ]);
  expect(safe?.exception?.values?.[1]?.stacktrace?.frames).toHaveLength(1);
  expect(safe?.tags).toEqual({ stage: 'react', app_version: productRelease.version });
  expect(safe?.debug_meta?.images).toHaveLength(1);
  expect(safe?.fingerprint).toBeUndefined();
  expect(JSON.stringify(safe)).not.toContain('SECRET');
});

it('accepts native error events without a product failure category and drops foreign-only errors', () => {
  const event: ErrorEvent = {
    type: undefined,
    exception: {
      values: [
        {
          type: 'TypeError',
          value: 'PRIVATE',
          stacktrace: { frames: [{ filename: `${origin}/assets/app.js`, lineno: 1 }] },
        },
      ],
    },
  };
  expect(sanitizeErrorEvent(event, origin, 'r')?.exception?.values?.[0]?.type).toBe('TypeError');
  expect(sanitizeErrorEvent({ type: undefined, message: 'PRIVATE' }, origin, 'r')).toBeNull();
  expect(
    sanitizeErrorEvent(
      {
        ...event,
        exception: {
          values: [{ stacktrace: { frames: [{ filename: 'chrome-extension://abc/file.js' }] } }],
        },
      },
      origin,
      'r',
    ),
  ).toBeNull();
});

it('strips arbitrary exception names, mechanisms and context while preserving fixed reasons', () => {
  const safe = sanitizeErrorEvent(
    {
      type: undefined,
      tags: {
        operation: 'roll',
        stage: 'response',
        error_code: 'INVALID_RESPONSE',
        replay_reason: 'OUTCOME_MISMATCH',
        token: 'SECRET',
      },
      exception: {
        values: [
          {
            type: 'SECRET',
            value: 'SECRET',
            mechanism: {
              type: 'SECRET',
              handled: true,
              source: 'SECRET',
              data: { token: 'SECRET' },
            },
          },
        ],
      },
    },
    origin,
    'r',
  );
  expect(safe?.tags).toMatchObject({
    operation: 'roll',
    stage: 'response',
    error_code: 'INVALID_RESPONSE',
    replay_reason: 'OUTCOME_MISMATCH',
  });
  expect(safe?.exception?.values?.[0]?.mechanism?.handled).toBe(true);
  expect(JSON.stringify(safe)).not.toContain('SECRET');
});

it('the real SDK preserves TypeError and linked Error causes in sanitized envelopes', async () => {
  const errors = collector();
  const cause = new RangeError('PRIVATE cause');
  cause.stack = `RangeError: PRIVATE cause\n    at cause (${origin}/assets/cause.js:7:8)`;
  errors.reportUnexpected(failure(2, cause), { stage: 'react' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  const event = envelopes()[0];
  expect(event?.exception?.values?.map((exception) => exception.type)).toEqual([
    'RangeError',
    'TypeError',
  ]);
  expect(event?.exception?.values?.[0]?.mechanism).toMatchObject({
    type: 'chained',
    source: 'cause',
    parent_id: 0,
  });
  expect(event?.exception?.values?.[1]?.mechanism?.handled).toBe(true);
  expect(event?.release).toBe(productRelease.version);
  expect(event?.tags).toEqual({ app_version: productRelease.version, stage: 'react' });
  expect(JSON.stringify(event)).not.toContain('PRIVATE');
  expect(event?.fingerprint).toBeUndefined();
  expect(event?.user).toBeUndefined();
  expect(event?.breadcrumbs).toBeUndefined();
});

it.each([WebAssembly.CompileError, WebAssembly.LinkError, WebAssembly.RuntimeError])(
  'the real SDK preserves the native %s type while redacting its contents',
  async (ErrorConstructor) => {
    const errors = collector();
    const error = new ErrorConstructor('PRIVATE');
    error.stack = `${error.name}: PRIVATE\n    at run (${origin}/assets/app.js:4:2)`;
    errors.reportUnexpected(error, { stage: 'dice' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(envelopes()[0]?.exception?.values).toMatchObject([
      { type: error.name, value: '[redacted]' },
    ]);
    expect(JSON.stringify(envelopes())).not.toContain('PRIVATE');
  },
);

it.each([
  'WebConfigError',
  'GameApiParseError',
  'RapierInitializationError',
  'ReplayCanonicalizationError',
  'SimulationInputError',
])('preserves the fixed product exception name %s without free text', (name) => {
  const event = sanitizeErrorEvent(
    { type: undefined, exception: { values: [{ type: name, value: 'PRIVATE' }] } },
    origin,
    'r',
  );
  expect(event?.exception?.values).toMatchObject([{ type: name, value: '[redacted]' }]);
  expect(JSON.stringify(event)).not.toContain('PRIVATE');
});

it('captures one Error identity once while preserving more than 30 separate occurrences at the same location', async () => {
  const errors = collector();
  const original = failure(1);
  errors.reportUnexpected(original, { operation: 'roll' });
  errors.reportUnexpected(original, { operation: 'roll' });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  for (let occurrence = 0; occurrence < 35; occurrence += 1) {
    errors.reportUnexpected(failure(1), { operation: 'roll' });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(occurrence + 2));
  }
  expect(fetch).toHaveBeenCalledTimes(36);
  expect(envelopes().every((event) => event.fingerprint === undefined)).toBe(true);
});

it('does not transmit a non-Error rejection payload or arbitrary Error properties', async () => {
  const errors = collector();
  const error = Object.assign(failure(4), { seatToken: 'PRIVATE' });
  errors.reportUnexpected(error);
  // The native browser capture stack points into the bundle; Vitest runs this
  // adapter from local source, so give the SDK's synthetic stack that same origin.
  const NativeError = Error;
  vi.stubGlobal(
    'Error',
    class extends NativeError {
      public constructor(message?: string) {
        super(message);
        if (message === 'Sentry syntheticException')
          this.stack = `Error: ${message}\n    at capture (${origin}/assets/app.js:4:2)`;
      }
    },
  );
  errors.reportUnexpected({ seatToken: 'PRIVATE', url: `${origin}/?token=PRIVATE` });
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(JSON.stringify(envelopes())).not.toContain('PRIVATE');
  expect(
    envelopes().every((event) => event.extra === undefined && event.request === undefined),
  ).toBe(true);
});
