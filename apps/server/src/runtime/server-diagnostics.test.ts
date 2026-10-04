import type { BunOptions, ErrorEvent } from '@sentry/bun';
import { expect, test } from 'bun:test';

import { type ServerDiagnosticsSdk, startServerDiagnostics } from '@/runtime/server-diagnostics';

function sdkFixture() {
  let options: BunOptions | undefined;
  const captures: unknown[] = [];
  let closes = 0;
  const sdk: ServerDiagnosticsSdk = {
    init: (value) => {
      options = value;
      return undefined;
    },
    captureException: (error) => {
      captures.push(error);
      return 'event';
    },
    linkedErrorsIntegration: () => ({ name: 'LinkedErrors' }),
    close: async () => {
      closes += 1;
      return true;
    },
  };
  return { sdk, captures, options: () => options, closes: () => closes };
}

const active = { dsn: 'https://public@o0.ingest.sentry.io/0' };

test('inactive diagnostics never loads the SDK or installs process listeners', async () => {
  let loads = 0;
  const before = [
    process.listenerCount('uncaughtException'),
    process.listenerCount('unhandledRejection'),
  ];
  const diagnostics = await startServerDiagnostics({ dsn: null }, async () => {
    loads += 1;
    throw new Error('must not load');
  });
  diagnostics.reportUnexpected(new Error('ignored'), 'startup');
  await diagnostics.close();
  expect(loads).toBe(0);
  expect([
    process.listenerCount('uncaughtException'),
    process.listenerCount('unhandledRejection'),
  ]).toEqual(before);
});

test('reports the original Error/cause and closes the owned SDK/listeners once', async () => {
  const fixture = sdkFixture();
  const before = [
    process.listenerCount('uncaughtException'),
    process.listenerCount('unhandledRejection'),
  ];
  const diagnostics = await startServerDiagnostics(active, async () => fixture.sdk);
  try {
    const error = new RangeError('private', { cause: new TypeError('private cause') });
    diagnostics.reportUnexpected(error, 'startup');
    expect(fixture.captures).toEqual([error]);
    expect(fixture.captures[0]).toBe(error);
    expect(fixture.options()).toMatchObject({
      defaultIntegrations: false,
      tracesSampleRate: 0,
      dataCollection: {
        userInfo: false,
        httpHeaders: false,
        httpBodies: [],
        stackFrameVariables: false,
      },
      sendClientReports: false,
    });
    expect([
      process.listenerCount('uncaughtException'),
      process.listenerCount('unhandledRejection'),
    ]).toEqual(before.map((count) => count + 1));
    await Promise.all([diagnostics.close(), diagnostics.close()]);
    expect(fixture.closes()).toBe(1);
    expect([
      process.listenerCount('uncaughtException'),
      process.listenerCount('unhandledRejection'),
    ]).toEqual(before);
    diagnostics.reportUnexpected(error, 'shutdown');
    expect(fixture.captures).toHaveLength(1);
  } finally {
    await diagnostics.close();
  }
});

test('retains relative source positions/chain while removing sensitive event and attachment data', async () => {
  const fixture = sdkFixture();
  const diagnostics = await startServerDiagnostics(active, async () => fixture.sdk);
  const canary = 'PRIVATE_EVENT_CANARY';
  try {
    const event: ErrorEvent = {
      type: undefined,
      event_id: '0123456789abcdef0123456789abcdef',
      message: canary,
      user: { id: canary, ip_address: canary },
      request: { url: canary, headers: { authorization: canary }, data: canary },
      contexts: { private: { canary } },
      extra: { canary },
      breadcrumbs: [{ message: canary }],
      tags: { operation: 'startup', private: canary },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: canary,
            stacktrace: {
              frames: [
                {
                  filename: '/private/runtime/packages/dice-simulation/src/contract/validation.ts',
                  function: 'parseSimulationInput',
                  lineno: 32,
                  colno: 11,
                  vars: { canary },
                  pre_context: [canary],
                },
              ],
            },
            mechanism: {
              type: 'chained',
              handled: true,
              exception_id: 1,
              parent_id: 0,
              source: 'cause',
              data: { canary },
            },
          },
          {
            type: 'RangeError',
            value: canary,
            stacktrace: {
              frames: [
                { filename: '/runtime/src/main.ts', function: 'start', lineno: 9, colno: 3 },
              ],
            },
            mechanism: { type: 'auto.node.onunhandledrejection', handled: false, exception_id: 0 },
          },
        ],
      },
    };
    const hint = { attachments: [{ filename: canary, data: canary }] };
    const projected = await fixture.options()?.beforeSend?.(event, hint);
    expect(JSON.stringify(projected)).not.toContain(canary);
    expect(hint.attachments).toEqual([]);
    expect(projected).toMatchObject({
      tags: { operation: 'startup' },
      exception: {
        values: [
          {
            type: 'TypeError',
            stacktrace: {
              frames: [
                {
                  filename: 'packages/dice-simulation/src/contract/validation.ts',
                  function: 'parseSimulationInput',
                  lineno: 32,
                  colno: 11,
                },
              ],
            },
            mechanism: { parent_id: 0, source: 'cause' },
          },
          {
            type: 'RangeError',
            stacktrace: { frames: [{ filename: 'apps/server/src/main.ts', lineno: 9 }] },
            mechanism: { handled: false, type: 'auto.node.onunhandledrejection' },
          },
        ],
      },
    });
    expect(projected?.release).toBeTruthy();
  } finally {
    await diagnostics.close();
  }
});

test('SDK load, init, capture and close failures stay inside diagnostics', async () => {
  const unloaded = await startServerDiagnostics(active, async () => {
    throw new Error('load');
  });
  unloaded.reportUnexpected(new Error('ignored'), 'startup');
  await unloaded.close();
  const fixture = sdkFixture();
  fixture.sdk.init = () => {
    throw new Error('init');
  };
  const failedInit = await startServerDiagnostics(active, async () => fixture.sdk);
  failedInit.reportUnexpected(new Error('ignored'), 'startup');
  await failedInit.close();
  expect(fixture.captures).toEqual([]);
  const failing = sdkFixture();
  failing.sdk.captureException = () => {
    throw new Error('capture');
  };
  failing.sdk.close = async () => {
    throw new Error('close');
  };
  const diagnostics = await startServerDiagnostics(active, async () => failing.sdk);
  expect(() => diagnostics.reportUnexpected(new Error('original'), 'shutdown')).not.toThrow();
  await diagnostics.close();
});

test.each([
  'manual',
  'private-names',
  'uncaught',
  'rejection',
  'abort',
  'timer-rejection',
  'close-reject',
  'close-pending',
])('actual SDK %s sends one sanitized envelope and respects the process outcome', async (mode) => {
  const moduleUrl = new URL('./server-diagnostics.ts', import.meta.url).href;
  const configUrl = new URL('./server-config.ts', import.meta.url).href;
  const sdkUrl = Bun.resolveSync('@sentry/bun', import.meta.dir);
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
      import { startServerDiagnostics } from ${JSON.stringify(moduleUrl)};
      import { parseServerConfig } from ${JSON.stringify(configUrl)};
      import * as Sentry from ${JSON.stringify(sdkUrl)};
      const mode = ${JSON.stringify(mode)};
      const diagnostics = await startServerDiagnostics({ dsn: 'https://public@o0.ingest.sentry.io/0' }, async () => ({
        ...Sentry,
        init(options) {
          return Sentry.init({ ...options, transport: () => ({
            send(envelope) { console.log(JSON.stringify({ envelope })); return Promise.resolve({ statusCode: 200 }); },
            flush() {
              if (mode === 'close-reject') return Promise.reject(new Error('PRIVATE_FATAL_CANARY'));
              if (mode === 'close-pending') return new Promise(() => {});
              return Promise.resolve(true);
            },
          }) });
        },
      }));
      Sentry.setUser({ id: 'PRIVATE_FATAL_CANARY', ip_address: 'PRIVATE_FATAL_CANARY' });
      Sentry.setExtra('private', 'PRIVATE_FATAL_CANARY');
      Sentry.setContext('private', { body: 'PRIVATE_FATAL_CANARY' });
      Sentry.addBreadcrumb({ message: 'PRIVATE_FATAL_CANARY' });
      Sentry.getCurrentScope().addAttachment({ filename: 'PRIVATE_FATAL_CANARY', data: 'PRIVATE_FATAL_CANARY' });
      Sentry.getCurrentScope().addEventProcessor(event => ({ ...event, request: { url: 'PRIVATE_FATAL_CANARY', headers: { authorization: 'PRIVATE_FATAL_CANARY' }, data: 'PRIVATE_FATAL_CANARY' } }));
      let error;
      try { parseServerConfig({ PORT: 'invalid' }); } catch (original) { error = original; }
      error.message = 'PRIVATE_FATAL_CANARY';
      error.cause = new RangeError('PRIVATE_FATAL_CANARY');
      if (mode === 'abort') error.name = 'AbortError';
      if (mode === 'private-names') {
        error.name = 'PRIVATE_FATAL_CANARY';
        error.cause.name = 'PRIVATE_CAUSE_CANARY';
      }
      if (mode === 'manual' || mode === 'private-names') {
        diagnostics.reportUnexpected(error, 'startup');
        await diagnostics.close();
      } else if (mode === 'uncaught') setTimeout(() => { throw error; }, 0);
      else if (mode === 'timer-rejection') {
        setInterval(() => {}, 1000);
        setTimeout(() => { void Promise.reject(error); }, 0);
      } else void Promise.reject(error);
    `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const records = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const manual = mode === 'manual' || mode === 'private-names';
  expect(status).toBe(manual ? 0 : 1);
  expect(records).toHaveLength(1);
  expect(records[0].envelope[1]).toHaveLength(1);
  expect(records[0].envelope[1][0][0].type).toBe('event');
  const event = records[0].envelope[1][0][1];
  expect(event.exception.values.map((value: { type: string }) => value.type)).toEqual([
    mode === 'private-names' ? 'Error' : 'RangeError',
    mode === 'private-names' ? 'Error' : mode === 'abort' ? 'AbortError' : 'ServerConfigError',
  ]);
  expect(event.exception.values.at(-1).stacktrace.frames).toContainEqual(
    expect.objectContaining({
      filename: 'apps/server/src/runtime/server-config.ts',
    }),
  );
  expect(event.exception.values.at(-1).mechanism.handled).toBe(manual);
  expect(event.release).toBeTruthy();
  expect(stdout + stderr).not.toContain('PRIVATE_FATAL_CANARY');
  expect(stdout + stderr).not.toContain('PRIVATE_CAUSE_CANARY');
  expect(stderr).toBe('');
});

test('actual SDK retains fixed standard and owned Error types in root and cause envelopes', async () => {
  const names = [
    'Error',
    'EvalError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
    'AggregateError',
    'AbortError',
    'TimeoutError',
    'DataCloneError',
    'CompileError',
    'LinkError',
    'RuntimeError',
    'ServerConfigError',
    'RapierInitializationError',
    'ReplayCanonicalizationError',
    'SimulationInputError',
    'GameApiParseError',
    'RollSimulationExecutorError',
  ];
  const moduleUrl = new URL('./server-diagnostics.ts', import.meta.url).href;
  const configUrl = new URL('./server-config.ts', import.meta.url).href;
  const sdkUrl = Bun.resolveSync('@sentry/bun', import.meta.dir);
  const child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    import { startServerDiagnostics } from ${JSON.stringify(moduleUrl)};
    import { ServerConfigError } from ${JSON.stringify(configUrl)};
    import * as Sentry from ${JSON.stringify(sdkUrl)};
    const diagnostics = await startServerDiagnostics({ dsn: 'https://public@o0.ingest.sentry.io/0' }, async () => ({
      ...Sentry,
      init(options) { return Sentry.init({ ...options, transport: () => ({
        send(envelope) { console.log(JSON.stringify(envelope)); return Promise.resolve({ statusCode: 200 }); },
        flush() { return Promise.resolve(true); },
      }) }); },
    }));
    for (const name of ${JSON.stringify(names)}) {
      const cause = new ServerConfigError('PRIVATE_TYPE_CANARY');
      cause.name = name;
      const error = new ServerConfigError('PRIVATE_TYPE_CANARY');
      error.name = name;
      error.cause = cause;
      diagnostics.reportUnexpected(error, 'worker.job');
    }
    await diagnostics.close();
  `,
    ],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [status, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const envelopes = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(status).toBe(0);
  expect(envelopes).toHaveLength(names.length);
  envelopes.forEach((envelope, index) => {
    expect(envelope[1]).toHaveLength(1);
    expect(envelope[1][0][0].type).toBe('event');
    expect(envelope[1][0][1].exception.values.map((value: { type: string }) => value.type)).toEqual(
      [names[index], names[index]],
    );
  });
  expect(stdout + stderr).not.toContain('PRIVATE_TYPE_CANARY');
  expect(stderr).toBe('');
});
