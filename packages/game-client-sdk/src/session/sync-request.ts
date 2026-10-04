import { parseSyncAck } from '@repo/game-protocol/socket';

import {
  CLIENT_ERROR_CODE,
  type ClientError,
  createProtocolError,
  createServerError,
  createTransportError,
} from '../errors';
import { waitForAcknowledgement } from '../socket/acknowledgement';

type SyncResponse = Extract<ReturnType<typeof parseSyncAck>, { readonly ok: true }>;

export type SyncRequestResult = SyncResponse | { readonly ok: false; readonly error: ClientError };

/** One request only. The session owns cancellation, coalescing, clock and state application. */
export async function requestSync(options: {
  readonly timeoutMs: number;
  readonly emit: (acknowledge: (value: unknown) => void) => void;
  readonly signal: AbortSignal;
}): Promise<SyncRequestResult> {
  const received = await waitForAcknowledgement(options.emit, options.timeoutMs, options.signal);
  if (!received.ok || options.signal.aborted) {
    return {
      ok: false,
      error:
        options.signal.aborted || (!received.ok && received.reason === 'aborted')
          ? createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED)
          : createTransportError(CLIENT_ERROR_CODE.ACK_TIMEOUT),
    };
  }
  let ack;
  try {
    ack = parseSyncAck(received.value);
  } catch {
    return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE) };
  }
  return ack.ok
    ? ack
    : { ok: false, error: createServerError(ack.error, { requestId: ack.meta.requestId }) };
}
