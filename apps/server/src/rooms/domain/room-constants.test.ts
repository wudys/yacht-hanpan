import { describe, expect, it } from 'bun:test';

import {
  PRESENCE_STATUS,
  RECONNECT_GRACE_MS,
  ROOM_CLEANUP_REASON,
  ROOM_REJECTION_CODE,
  ROOM_STATUS,
  WAITING_ROOM_LIFETIME_MS,
} from '@/rooms/domain/room-constants';

describe('room constants', () => {
  it.each([ROOM_STATUS, PRESENCE_STATUS, ROOM_CLEANUP_REASON, ROOM_REJECTION_CODE])(
    'contains no duplicate values',
    (catalog) => {
      const values = Object.values(catalog);

      expect(new Set(values).size).toBe(values.length);
    },
  );

  it('locks canonical room durations', () => {
    expect(WAITING_ROOM_LIFETIME_MS).toBe(300_000);
    expect(RECONNECT_GRACE_MS).toBe(90_000);
  });
});
