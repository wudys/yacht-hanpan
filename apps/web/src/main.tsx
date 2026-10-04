import productRelease from '@repo/product-release';

import { showStartupFailure } from '@/bootstrap/startup-failure';
import { createGoogleAnalytics } from '@/runtime/telemetry/ga';
import { createTelemetry, type ErrorSink } from '@/runtime/telemetry/telemetry';
import { readTelemetryConfig } from '@/runtime/telemetry/telemetry-config';

async function start() {
  const telemetryConfig = readTelemetryConfig(import.meta.env, window.location.origin);
  let disposed = false;
  let stopWebApp: (() => void) | undefined;
  let telemetry: ReturnType<typeof createTelemetry> | undefined;
  let cancelDiagnosticWait: (() => void) | undefined;
  let removeStartupFailure: (() => void) | undefined;
  const onPageHide = (event: PageTransitionEvent): void => {
    if (event.persisted || disposed) return;
    disposed = true;
    window.removeEventListener('pagehide', onPageHide);
    cancelDiagnosticWait?.();
    removeStartupFailure?.();
    try {
      stopWebApp?.();
    } finally {
      stopWebApp = undefined;
      telemetry?.dispose();
      telemetry = undefined;
    }
  };
  window.addEventListener('pagehide', onPageHide);
  let errors: ErrorSink | undefined;
  if (telemetryConfig.enabled && telemetryConfig.sentryDsn) {
    try {
      let timeout: number | undefined;
      const diagnostics = await new Promise<
        typeof import('@/runtime/telemetry/sentry') | undefined
      >((resolve) => {
        cancelDiagnosticWait = () => {
          window.clearTimeout(timeout);
          resolve(undefined);
        };
        timeout = window.setTimeout(cancelDiagnosticWait, 1_000);
        void import('@/runtime/telemetry/sentry').then(resolve, () => resolve(undefined));
      });
      window.clearTimeout(timeout);
      cancelDiagnosticWait = undefined;
      if (disposed) return;
      if (diagnostics) {
        errors = diagnostics.createSentryErrors(
          telemetryConfig.sentryDsn,
          telemetryConfig.origin,
          productRelease.version,
        );
      }
    } catch {
      /* Error collection must not prevent the product from starting. */
    }
  }
  const activeTelemetry = createTelemetry({
    analytics:
      telemetryConfig.enabled && telemetryConfig.measurementId
        ? createGoogleAnalytics(telemetryConfig.measurementId, telemetryConfig.origin)
        : undefined,
    errors,
  });
  telemetry = activeTelemetry;
  if (disposed) {
    activeTelemetry.dispose();
    return;
  }
  await activeTelemetry.start();
  try {
    const { startWebApp } = await import('@/app/start-web-app');
    if (!disposed) stopWebApp = startWebApp(activeTelemetry);
  } catch (error) {
    if (!disposed) {
      activeTelemetry.reportUnexpected(error, { stage: 'modules' });
      removeStartupFailure = showStartupFailure();
    }
  }
}

void start();
