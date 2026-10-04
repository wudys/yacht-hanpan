import type { RoomRejectionCode } from '@/rooms/domain/room-constants';
import type { Room, RoomTransition } from '@/rooms/domain/room-model';

export function roomChanged<Next extends Room>(room: Next): RoomTransition<Next> {
  return { ok: true, changed: true, room };
}

export function roomUnchanged<Previous extends Room>(
  room: Previous,
): RoomTransition<never, Previous> {
  return { ok: true, changed: false, room };
}

export function roomRejected<Previous extends Room>(
  room: Previous,
  code: RoomRejectionCode,
): Extract<RoomTransition<never, Previous>, { readonly ok: false }> {
  return { ok: false, changed: false, room, code };
}
