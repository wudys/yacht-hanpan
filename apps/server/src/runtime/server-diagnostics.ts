import release from '@repo/product-release';
import type { ErrorEvent, EventHint, StackFrame } from '@sentry/bun';

import { type ErrorReporter, SERVER_ERROR_OPERATIONS } from '@/runtime/error-reporter';
import type { ServerDiagnosticsConfig } from '@/runtime/server-diagnostics-config';

const CLOSE_TIMEOUT_MS = 2_000;
// Error.name is writable; only fixed diagnostic types may leave the process.
const KNOWN_ERROR_TYPES = new Set([
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
]);
export type ServerDiagnosticsSdk = Pick<
  typeof import('@sentry/bun'),
  'init' | 'captureException' | 'close' | 'linkedErrorsIntegration'
>;
export interface ServerDiagnostics {
  readonly reportUnexpected: ErrorReporter;
  readonly close: () => Promise<void>;
}
const inactive: ServerDiagnostics = {
  reportUnexpected: () => undefined,
  close: async () => undefined,
};

export async function startServerDiagnostics(
  config: ServerDiagnosticsConfig,
  loadSdk: () => Promise<ServerDiagnosticsSdk> = () => import('@sentry/bun'),
): Promise<ServerDiagnostics> {
  if (config.dsn === null) return inactive;
  let sdk: ServerDiagnosticsSdk;
  try {
    sdk = await loadSdk();
    sdk.init({
      dsn: config.dsn,
      release: release.version,
      debug: false,
      spotlight: false,
      defaultIntegrations: false,
      integrations: [sdk.linkedErrorsIntegration()],
      tracesSampleRate: 0,
      includeServerName: false,
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
      beforeSend: projectEvent,
    });
  } catch {
    return inactive;
  }

  let closing: Promise<void> | null = null;
  let fatal = false;
  const capture: ErrorReporter = (error, operation) => {
    if (closing !== null) return;
    try {
      sdk.captureException(error, { captureContext: { tags: { operation } } });
    } catch {
      // Never turn a reporting failure into another game failure.
    }
  };
  const close = (): Promise<void> => {
    if (closing !== null) return closing;
    closing = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
      // Keep a reference alive: Bun can otherwise exit before the SDK's unref'ed flush completes.
      const finish = (): void => {
        clearTimeout(timer);
        resolve();
      };
      try {
        void Promise.resolve(sdk.close(CLOSE_TIMEOUT_MS))
          .catch(() => undefined)
          .finally(finish);
      } catch {
        finish();
      }
    }).finally(() => {
      // Bun checks rejection listeners again after dispatch; keep them through the flush.
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    });
    return closing;
  };
  const captureFatal = (error: unknown, type: string): void => {
    if (fatal) return;
    fatal = true;
    process.exitCode = 1;
    try {
      sdk.captureException(error, {
        mechanism: { type, handled: false },
        captureContext: { level: 'fatal' },
      });
    } catch {
      // The original fatal exit must survive a failing SDK.
    }
    void close().finally(() => process.exit(1));
  };
  function onUncaught(error: Error): void {
    captureFatal(error, 'auto.node.onuncaughtexception');
  }
  function onRejection(error: unknown): void {
    captureFatal(error, 'auto.node.onunhandledrejection');
  }
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);
  return { reportUnexpected: capture, close };
}

function projectEvent(event: ErrorEvent, hint: EventHint): ErrorEvent {
  hint.attachments = [];
  const operation = SERVER_ERROR_OPERATIONS.find((value) => value === event.tags?.operation);
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: 'javascript',
    release: release.version,
    ...(operation === undefined ? {} : { tags: { operation } }),
    exception: {
      values: event.exception?.values?.map((exception) => {
        const type =
          exception.type && KNOWN_ERROR_TYPES.has(exception.type) ? exception.type : 'Error';
        const { mechanism } = exception;
        return {
          type,
          value: type,
          ...(exception.stacktrace
            ? {
                stacktrace: {
                  frames: exception.stacktrace.frames
                    ?.map(projectFrame)
                    .filter((frame) => frame !== null),
                },
              }
            : {}),
          ...(mechanism
            ? {
                mechanism: {
                  type: [
                    'generic',
                    'chained',
                    'auto.node.onuncaughtexception',
                    'auto.node.onunhandledrejection',
                  ].includes(mechanism.type)
                    ? mechanism.type
                    : 'generic',
                  handled: mechanism.handled,
                  exception_id: mechanism.exception_id,
                  parent_id: mechanism.parent_id,
                  ...(mechanism.source === 'cause' ? { source: 'cause' } : {}),
                },
              }
            : {}),
        };
      }),
    },
  };
}

function projectFrame(frame: StackFrame): StackFrame | null {
  const filename = sourceFilename(frame.filename);
  if (filename === null) return null;
  return {
    filename,
    ...(frame.function && /^[A-Za-z0-9_$.[\]<>?: ]{1,120}$/u.test(frame.function)
      ? { function: frame.function }
      : {}),
    ...(Number.isSafeInteger(frame.lineno) && Number(frame.lineno) > 0
      ? { lineno: frame.lineno }
      : {}),
    ...(Number.isSafeInteger(frame.colno) && Number(frame.colno) > 0 ? { colno: frame.colno } : {}),
    in_app: true,
  };
}

function sourceFilename(value: string | undefined): string | null {
  if (
    !value ||
    /[?#]|node_modules/u.test(value) ||
    (/^[a-z]+:\/\//iu.test(value) && !value.startsWith('file://'))
  )
    return null;
  const filename = value.replace(/^file:\/\//u, '').replaceAll('\\', '/');
  for (const marker of ['/apps/server/src/', '/packages/']) {
    const index = filename.indexOf(marker);
    if (index >= 0) return filename.slice(index + 1);
    if (filename.startsWith(marker.slice(1))) return filename;
  }
  const source = filename.indexOf('/src/');
  if (source >= 0) return `apps/server${filename.slice(source)}`;
  if (filename.startsWith('src/')) return `apps/server/${filename}`;
  const basename = filename.split('/').at(-1);
  return basename === 'main.js' || basename === 'roll-simulation.worker.js' ? basename : null;
}
