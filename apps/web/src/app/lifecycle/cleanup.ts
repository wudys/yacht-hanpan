import type { ErrorContext } from '@/runtime/telemetry/error-policy';
import type { Telemetry } from '@/runtime/telemetry/telemetry';

export function createCleanupRunner(telemetry: Pick<Telemetry, 'reportUnexpected'>) {
  return (callback: () => void | Promise<void>, context?: ErrorContext): void => {
    const report = (error: unknown) => {
      try {
        if (context) telemetry.reportUnexpected(error, context);
        else telemetry.reportUnexpected(error);
      } catch {
        // A failed diagnostic must not interrupt the remaining cleanup.
      }
    };
    try {
      void Promise.resolve(callback()).catch(report);
    } catch (error) {
      report(error);
    }
  };
}
