import { GAME_COMMAND_TYPE, type GameCommand } from '@repo/game-protocol/socket';

import type { RoomCommandTime } from '@/rooms/domain/event-time';

export function captureCommandTime(
  commandType: GameCommand['type'],
  receivedAt: number,
): RoomCommandTime {
  return {
    source: 'command',
    effectiveAt: receivedAt,
    priority: commandType === GAME_COMMAND_TYPE.FORFEIT_MATCH ? 'forfeit' : 'gameplay',
  };
}
