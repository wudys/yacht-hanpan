import { captureReactException } from '@sentry/react';
import type { ErrorInfo } from 'react';

export function createReactErrorHandler(handled: boolean) {
  return (error: unknown, errorInfo: ErrorInfo) => {
    try {
      captureReactException(error, errorInfo, {
        mechanism: { handled, type: 'auto.function.react.error_handler' },
        captureContext: { tags: { stage: 'react' } },
      });
    } catch {
      /* A diagnostic failure must not change React's error handling. */
    }
  };
}
