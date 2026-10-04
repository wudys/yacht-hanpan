import { expect, test } from 'bun:test';

import { createRoom } from '@/rooms/domain/create-room';
import { joinRoom } from '@/rooms/domain/join-room';
import { roomId } from '@/rooms/domain/room-model';

test.each([false, true])('preserves duplicate character and selected variant=%p', (variant) => {
  const created = createRoom({
    roomId: roomId('profile-room'),
    code: '123456',
    characterId: 'navy-bob',
    variant,
    createdAt: 1000,
  });
  if (!created.ok) throw new Error('room creation rejected');
  const joined = joinRoom(created.room, { characterId: 'navy-bob', variant, joinedAt: 2000 });
  expect(joined.ok).toBe(true);
  expect(joined.room.seats.map((seat) => seat.profile)).toEqual([
    { characterId: 'navy-bob', variant },
    { characterId: 'navy-bob', variant },
  ]);
});
