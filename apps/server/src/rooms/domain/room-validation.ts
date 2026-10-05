import type { RoomCode } from '@/rooms/domain/room-model';

export function isRoomCode(value: unknown): value is RoomCode {
  return typeof value === 'string' && /^\d{6}$/u.test(value);
}
