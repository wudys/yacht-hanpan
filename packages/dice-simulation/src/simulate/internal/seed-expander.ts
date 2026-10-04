import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const MAX_SAFE_RANDOM_INTEGER = 0x1f_ffff_ffff_ffff;

/** Versioned SHA-256 counter expansion shared by Bun and supported browsers. */
export function seededNumber(seed: string, index: number): number {
  const digest = sha256(utf8ToBytes(`${seed}:${index}`));
  const integer =
    (digest[0] % 32) * 2 ** 48 +
    digest[1] * 2 ** 40 +
    digest[2] * 2 ** 32 +
    digest[3] * 2 ** 24 +
    digest[4] * 2 ** 16 +
    digest[5] * 2 ** 8 +
    digest[6];
  return integer / MAX_SAFE_RANDOM_INTEGER;
}
