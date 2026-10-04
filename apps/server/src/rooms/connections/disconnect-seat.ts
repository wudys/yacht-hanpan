import type { SeatIndex } from '@repo/yacht-rules';

import type { RoomStateCommitter } from '@/rooms/commit';
import type { ActiveConnectionRegistry } from '@/rooms/connections/connection-registry';
import { disconnectSeat } from '@/rooms/domain/presence';
import { ROOM_STATUS } from '@/rooms/domain/room-constants';
import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomRepositoryReader } from '@/rooms/repository';
import type { RoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

export interface DisconnectSeatInput {
  readonly roomId: RoomId;
  readonly seatIndex: SeatIndex;
  readonly connectionId: string;
  readonly disconnectedAt: number;
}

export interface DisconnectSeatDependencies {
  readonly connections: ActiveConnectionRegistry;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly commits: Pick<RoomStateCommitter, 'commitPresence'>;
}

export function executeDisconnectSeat(
  input: DisconnectSeatInput,
  dependencies: DisconnectSeatDependencies,
): Promise<boolean> {
  return dependencies.queue.run(input.roomId, () => {
    if (!dependencies.connections.unbind(input.roomId, input.seatIndex, input.connectionId)) {
      return false;
    }
    const current = dependencies.repository.getById(input.roomId);
    if (current === undefined || current.room.status === ROOM_STATUS.FINISHED) {
      return false;
    }
    const transition = disconnectSeat(current.room, {
      seatIndex: input.seatIndex,
      detectedAt: input.disconnectedAt,
    });
    if (!transition.ok || !transition.changed) return false;

    const committed = dependencies.commits.commitPresence({ current, room: transition.room });
    return committed.ok;
  });
}
