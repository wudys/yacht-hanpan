import { CLIENT_ERROR_CODE, type ClientError } from '@repo/game-client-sdk/errors';

import type { PlaybackFallbackReason } from '@/runtime/dice/replay';

export const ERROR_CONTEXT_VALUES = {
  replay_reason: [
    'DIGEST_MISMATCH',
    'OUTCOME_MISMATCH',
    'SIMULATION_FAILED',
  ] satisfies readonly PlaybackFallbackReason[],
  operation: ['create', 'join', 'cancel', 'roll', 'hold', 'score', 'forfeit', 'synchronize'],
  stage: [
    'storage',
    'modules',
    'audio',
    'dice',
    'bgm',
    'react',
    'canvas',
    'replay',
    'snapshot',
    'invoke',
    'response',
    'promise',
  ],
  error_code: [CLIENT_ERROR_CODE.INVALID_RESPONSE],
} as const;
export type ErrorContext = {
  readonly [Key in keyof typeof ERROR_CONTEXT_VALUES]?: (typeof ERROR_CONTEXT_VALUES)[Key][number];
};

export interface ErrorReporter {
  reportUnexpected(error: unknown, context?: ErrorContext): void;
}

export function reportClientFailure(
  reporter: ErrorReporter,
  error: ClientError,
  context?: ErrorContext,
) {
  // A public server refusal is diagnosed by the server. Only a verified client
  // reception contract violation belongs to this browser boundary.
  if (error.kind !== 'protocol' || error.code !== CLIENT_ERROR_CODE.INVALID_RESPONSE) return;
  reporter.reportUnexpected(new Error(CLIENT_ERROR_CODE.INVALID_RESPONSE), {
    ...context,
    error_code: CLIENT_ERROR_CODE.INVALID_RESPONSE,
  });
}
