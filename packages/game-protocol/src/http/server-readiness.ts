export const SERVER_READINESS_PATH = '/health/ready';

export type ServerReadinessPayload = Readonly<{
  ok: boolean;
  runtime: 'bun';
}>;

// Readiness gates admission; compatibility is checked by the subsequent room request.
// Additional diagnostic fields do not change whether this server can accept work.
export function isServerReadyPayload(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    value.ok === true &&
    'runtime' in value &&
    value.runtime === 'bun'
  );
}
