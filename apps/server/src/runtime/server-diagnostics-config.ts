// Public product endpoint. Collection requires SENTRY_ENABLED=true.
export const SERVER_DIAGNOSTICS_SETTINGS = {
  sentryDsn:
    'https://0da9289a869b371cf1a093479ea6340b@o4512145535991808.ingest.us.sentry.io/4512186746732544',
};

export interface ServerDiagnosticsConfig {
  readonly dsn: string | null;
}

export function readServerDiagnosticsConfig(
  environment: Readonly<Record<string, string | undefined>>,
  settings: typeof SERVER_DIAGNOSTICS_SETTINGS = SERVER_DIAGNOSTICS_SETTINGS,
): ServerDiagnosticsConfig {
  if (environment.SENTRY_ENABLED !== 'true') return { dsn: null };
  try {
    const dsn = new URL(settings.sentryDsn);
    if (
      dsn.protocol === 'https:' &&
      /^[a-z0-9]+$/iu.test(dsn.username) &&
      !dsn.password &&
      /^o\d+\.ingest(?:\.[a-z]+)?\.sentry\.io$/u.test(dsn.hostname) &&
      /^\/\d+$/u.test(dsn.pathname) &&
      !dsn.search &&
      !dsn.hash &&
      !dsn.port
    )
      return { dsn: dsn.href };
  } catch {
    // An optional diagnostic setting must neither block startup nor select arbitrary endpoints.
  }
  return { dsn: null };
}
