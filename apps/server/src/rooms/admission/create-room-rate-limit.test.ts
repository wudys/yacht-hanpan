import { describe, expect, test } from 'bun:test';

import { CreateRoomRateLimiter } from '@/rooms/admission/create-room-rate-limit';

describe('create-room rate limiter', () => {
  test('prunes idle expired addresses without consuming or extending active attempts', () => {
    const limiter = new CreateRoomRateLimiter();
    limiter.consume({ ipAddress: 'expired', attemptedAt: 1_000 });
    for (let index = 0; index < 10; index += 1)
      limiter.consume({ ipAddress: 'active', attemptedAt: 2_000 });
    limiter.prune(61_000);
    expect(limiter.trackedAddressCount).toBe(1);
    expect(limiter.consume({ ipAddress: 'active', attemptedAt: 61_000 })).toEqual({
      ok: false,
      retryAfterMs: 1_000,
    });
    limiter.prune(62_000);
    expect(limiter.trackedAddressCount).toBe(0);
  });

  test('allows ten attempts per IP and preserves the sliding-minute deadline', () => {
    const limiter = new CreateRoomRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.consume({ ipAddress: '198.51.100.7', attemptedAt: 5_000 + attempt })).toEqual({
        ok: true,
      });
    }
    expect(limiter.consume({ ipAddress: '198.51.100.7', attemptedAt: 6_000 })).toEqual({
      ok: false,
      retryAfterMs: 59_000,
    });
    expect(limiter.consume({ ipAddress: '198.51.100.7', attemptedAt: 64_999 })).toEqual({
      ok: false,
      retryAfterMs: 1,
    });
    expect(limiter.consume({ ipAddress: '198.51.100.7', attemptedAt: 65_000 })).toEqual({
      ok: true,
    });
    expect(limiter.consume({ ipAddress: '198.51.100.7', attemptedAt: 65_000 })).toEqual({
      ok: false,
      retryAfterMs: 1,
    });
  });

  test('keeps different IP allowances independent', () => {
    const limiter = new CreateRoomRateLimiter();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.consume({ ipAddress: '198.51.100.7', attemptedAt: 5_000 });
    }
    expect(limiter.consume({ ipAddress: '198.51.100.8', attemptedAt: 5_000 })).toEqual({
      ok: true,
    });
  });

  test('globally prunes expired process-local addresses', () => {
    const limiter = new CreateRoomRateLimiter();
    limiter.consume({ ipAddress: '203.0.113.1', attemptedAt: 1_000 });
    limiter.consume({ ipAddress: '203.0.113.2', attemptedAt: 61_000 });
    expect(limiter.trackedAddressCount).toBe(1);
  });
});
