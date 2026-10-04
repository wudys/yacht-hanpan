export const SERVER_ERROR_OPERATIONS = [
  'startup',
  'shutdown',
  'http.request',
  'room.publish',
  'socket.connection',
  'socket.disconnect',
  'socket.sync',
  'socket.command',
  'scheduler.task',
  'roll.command',
  'roll.result',
  'worker.startup',
  'worker.job',
  'worker.exit',
  'worker.timeout',
  'worker.response',
] as const;

export type ServerErrorOperation = (typeof SERVER_ERROR_OPERATIONS)[number];
export type ErrorReporter = (error: unknown, operation: ServerErrorOperation) => void;

export function reportUnexpected(
  reporter: ErrorReporter | undefined,
  error: unknown,
  operation: ServerErrorOperation,
): void {
  try {
    reporter?.(error, operation);
  } catch {
    // Diagnostics must not change the result or cleanup of the owning operation.
  }
}
