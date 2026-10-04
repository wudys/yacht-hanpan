import { readPublicSiteOrigin } from '../../bootstrap/public-origin.ts'; // eslint-disable-line no-restricted-imports, import-x/extensions -- Also loaded by the native Vite config.

// Public, fixed product settings shared by the browser and source-map build.
// The deployment supplies VITE_SITE_ORIGIN; keep credentials in CI/CD only.
export const TELEMETRY_SETTINGS = {
  measurementId: 'G-RZBLW49TR1',
  sentryDsn:
    'https://0ed6ed0c7d3e1a8685fc9f545be62193@o4512145535991808.ingest.us.sentry.io/4512186737360896',
  sentryOrg: 'wudy',
  sentryProject: 'yacht-hanpan-client',
};

export type TelemetryConfig = Readonly<{
  enabled: boolean;
  origin: string;
  measurementId: string | null;
  sentryDsn: string | null;
}>;

// Fail closed. A production Vite bundle alone is also used by local preview/E2E.
export function readTelemetryConfig(
  env: Readonly<Record<string, unknown>>,
  origin: string,
  settings: typeof TELEMETRY_SETTINGS = TELEMETRY_SETTINGS,
): TelemetryConfig {
  const configuredOrigin = readPublicSiteOrigin(env);
  const measurementId = /^G-[A-Z0-9]+$/u.test(settings.measurementId)
    ? settings.measurementId
    : null;
  let sentryDsn: string | null = null;
  if (settings.sentryDsn) {
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
        sentryDsn = dsn.href;
    } catch {
      /* Never turn an invalid DSN into an arbitrary outbound endpoint. */
    }
  }
  return {
    enabled:
      env.PROD === true &&
      env.MODE === 'production' &&
      env.VITE_DEPLOYMENT_ENV === 'production' &&
      configuredOrigin !== '' &&
      origin === configuredOrigin,
    origin: configuredOrigin,
    measurementId,
    sentryDsn,
  };
}
