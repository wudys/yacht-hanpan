import { createHash, timingSafeEqual } from 'node:crypto';

import type { SeatIndex } from '@repo/yacht-rules';

import type { ServerIdentity } from '@/runtime/server-identity';

type Brand<Value, Name extends string> = Value & {
  readonly __brand: Name;
};

export type SeatTokenHash = Brand<string, 'SeatTokenHash'>;

export interface SeatCredential {
  readonly token: string;
  readonly hash: SeatTokenHash;
}

export function createSeatCredential(
  identity: Pick<ServerIdentity, 'createSeatToken'>,
): SeatCredential {
  const token: string = identity.createSeatToken();
  return { token, hash: hashSeatToken(token) };
}

export function hashSeatToken(token: string): SeatTokenHash {
  return seatTokenHash(createHash('sha256').update(token, 'utf8').digest('hex'));
}

export function seatTokenHash(value: string): SeatTokenHash {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('SeatTokenHash must be a lowercase SHA-256 hex digest');
  }
  return value as SeatTokenHash;
}

export function verifySeatToken(token: string, expectedHash: SeatTokenHash): boolean {
  const presented: Buffer = Buffer.from(hashSeatToken(token), 'hex');
  const expected: Buffer = Buffer.from(expectedHash, 'hex');
  return timingSafeEqual(presented, expected);
}

export function resolveSeatIndexForToken(
  token: string,
  credentialHashes: readonly [SeatTokenHash] | readonly [SeatTokenHash, SeatTokenHash],
): SeatIndex | undefined {
  const firstMatches = verifySeatToken(token, credentialHashes[0]);
  const secondHash = credentialHashes[1];
  const secondMatches = secondHash !== undefined && verifySeatToken(token, secondHash);
  if (firstMatches) return 0;
  return secondMatches ? 1 : undefined;
}
