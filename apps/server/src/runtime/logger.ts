export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  readonly debug: (event: string, fields?: LogFields) => void;
  readonly error: (event: string, fields?: LogFields) => void;
  readonly info: (event: string, fields?: LogFields) => void;
  readonly warn: (event: string, fields?: LogFields) => void;
}

type LogLevel = 'debug' | 'error' | 'info' | 'warn';
const LEVEL_PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
type LogSink = (line: string) => void;

const SENSITIVE_KEY_PATTERN = /authorization|credential.*hash|secret|token/iu;

// Diagnostics must never interrupt the operation or resource cleanup they describe.
// Retain only the supplied logging methods, including methods inherited from a class.
export function protectLogger<T extends Partial<Logger>>(
  logger: T,
): Pick<Logger, keyof T & keyof Logger> {
  const protectedLogger: Partial<Record<keyof Logger, Logger['error']>> = {};
  for (const level of ['debug', 'error', 'info', 'warn'] as const) {
    if (!(level in logger)) continue;
    protectedLogger[level] = (event, fields) => {
      try {
        logger[level]?.call(logger, event, fields);
      } catch {
        // Reporting through the same logger could recurse into the failed sink.
      }
    };
  }
  return protectedLogger as Pick<Logger, keyof T & keyof Logger>;
}

export function createJsonLogger(
  sink: LogSink = console.log,
  minimumLevel: LogLevel = 'info',
): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[minimumLevel]) return;
    const normalized = normalize(fields, new WeakSet<object>());
    const payload = isRecord(normalized) ? normalized : {};
    sink(JSON.stringify({ level, event, ...payload }));
  };

  return protectLogger({
    debug: (event, fields) => write('debug', event, fields),
    error: (event, fields) => write('error', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
  });
}

function normalize(value: unknown, seen: WeakSet<object>, key: string = ''): unknown {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (value instanceof Error) return { name: value.name };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'object') return String(typeof value);
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => normalize(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      normalize(entryValue, seen, entryKey),
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
