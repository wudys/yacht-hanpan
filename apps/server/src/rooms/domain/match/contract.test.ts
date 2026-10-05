import { describe, expect, test } from 'bun:test';

import { MATCH_REJECTION_CODE, MAX_ROLLS_PER_TURN, TURN_DURATION_MS } from '@/rooms/domain/match';

describe('match contract', () => {
  test('centralizes match limits and rejection codes', () => {
    expect(TURN_DURATION_MS).toBe(90_000);
    expect(MAX_ROLLS_PER_TURN).toBe(3);
    expect(MATCH_REJECTION_CODE.STALE_TURN).toBe('STALE_TURN');
    expect(MATCH_REJECTION_CODE.MATCH_FINISHED).toBe('MATCH_FINISHED');
    expect(new Set(Object.values(MATCH_REJECTION_CODE)).size).toBe(
      Object.values(MATCH_REJECTION_CODE).length,
    );
  });
});
