export const ROOM_CODE_LENGTH = 6;

export function normalizeRoomCode(value: string): string {
  return value.replace(/[^0-9]/gu, '').slice(0, ROOM_CODE_LENGTH);
}

export function isCompleteRoomCode(value: string): boolean {
  return value.length === ROOM_CODE_LENGTH && /^[0-9]+$/u.test(value);
}
