import { describe, expect, test } from 'bun:test';

import {
  createSeatCredential,
  hashSeatToken,
  resolveSeatIndexForToken,
  verifySeatToken,
} from '@/rooms/connections/seat-token';
import type { ServerIdentity } from '@/runtime/server-identity';

const RAW_TOKEN = 'd9428888-122b-4d34-8f6f-1f0f4f7f6b91';

function identityWithToken(token: string): ServerIdentity {
  return {
    createRequestId: () => 'unused-request-id',
    createRoomCodeCandidate: () => '000000',
    createRoomId: () => 'unused-room-id',
    createSeatToken: () => token,
    createTurnId: () => 'unused-turn-id',
  };
}

describe('seat credentials', () => {
  test('returns a raw token once while retaining only its lowercase SHA-256 hash', () => {
    const credential = createSeatCredential(identityWithToken(RAW_TOKEN));

    expect(credential.token).toBe(RAW_TOKEN);
    expect(credential.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(credential.hash).toBe(hashSeatToken(RAW_TOKEN));
    expect(credential.hash).not.toContain(RAW_TOKEN);
  });

  test('verifies a presented token with a digest comparison', () => {
    const hash = hashSeatToken(RAW_TOKEN);

    expect(verifySeatToken(RAW_TOKEN, hash)).toBeTrue();
    expect(verifySeatToken('9207e571-a39a-49d5-a75f-a08d5e52cce8', hash)).toBeFalse();
  });

  test('resolves the authenticated tuple position without a second seat identity', () => {
    const firstToken = RAW_TOKEN;
    const secondToken = '9207e571-a39a-49d5-a75f-a08d5e52cce8';
    const hashes = [hashSeatToken(firstToken), hashSeatToken(secondToken)] as const;

    expect(resolveSeatIndexForToken(firstToken, hashes)).toBe(0);
    expect(resolveSeatIndexForToken(secondToken, hashes)).toBe(1);
    expect(
      resolveSeatIndexForToken('a9af0b5e-e231-436a-8733-1ff04cb9e741', hashes),
    ).toBeUndefined();
    expect(resolveSeatIndexForToken(firstToken, [hashes[0]])).toBe(0);
  });
});
