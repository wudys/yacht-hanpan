import type { SeatIndex } from '@repo/yacht-rules';

import { PRESENCE_STATUS, ROOM_STATUS } from '@/rooms/domain/room-constants';
import type { Room } from '@/rooms/domain/room-model';

export function earliestReconnectDeadline(room: Room): {
  readonly seatIndex: SeatIndex;
  readonly reconnectDeadlineAt: number;
} | null {
  if (room.status !== ROOM_STATUS.PLAYING) return null;
  let earliest: { seatIndex: SeatIndex; reconnectDeadlineAt: number } | null = null;
  for (const seatIndex of [0, 1] as const) {
    const { presence } = room.seats[seatIndex];
    if (presence.status !== PRESENCE_STATUS.DISCONNECTED || presence.reconnectDeadlineAt === null)
      continue;
    if (earliest === null || presence.reconnectDeadlineAt < earliest.reconnectDeadlineAt) {
      earliest = { seatIndex, reconnectDeadlineAt: presence.reconnectDeadlineAt };
    }
  }
  return earliest;
}
