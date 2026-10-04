import type { ClientError } from '@repo/game-client-sdk/errors';
import { PUBLIC_ERROR_CODE } from '@repo/game-protocol';

export function isPermanentAuthorityFailure(error: ClientError): boolean {
  return (
    error.kind === 'server' &&
    (error.error.code === PUBLIC_ERROR_CODE.ROOM_NOT_FOUND ||
      error.error.code === PUBLIC_ERROR_CODE.INVALID_AUTHORITY ||
      error.error.code === PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE)
  );
}
