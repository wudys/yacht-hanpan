import { reconcileRoomDeadlines } from '@/rooms/application/reconcile-room-deadlines';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { deadlineTime, isReceiptGroupClosed, receiptGroupWakeAt } from '@/rooms/domain/event-time';
import { nextRoomDeadline } from '@/rooms/domain/room-deadlines';
import type { RoomId } from '@/rooms/domain/room-model';
import { isPlayingRoomState } from '@/rooms/domain/room-state';
import type { Clock } from '@/runtime/clock';
import type { ServerIdentity } from '@/runtime/server-identity';
import type { TaskScheduler } from '@/runtime/task-scheduler';

export interface RoomDeadlineSchedulerDependencies {
  readonly clock: Clock;
  readonly identity: Pick<ServerIdentity, 'createTurnId'>;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly tasks: Pick<TaskScheduler, 'schedule' | 'cancel'>;
  readonly commits: Pick<RoomStateCommitter, 'commitGame'>;
}

export class RoomDeadlineScheduler {
  readonly #dependencies: RoomDeadlineSchedulerDependencies;

  public constructor(dependencies: RoomDeadlineSchedulerDependencies) {
    this.#dependencies = dependencies;
  }

  public reconcile(roomId: RoomId): void {
    const record = this.#dependencies.repository.getById(roomId);
    const dueAt =
      record !== undefined && isPlayingRoomState(record) ? nextRoomDeadline(record) : null;
    const key = String(roomId);
    if (dueAt === null) {
      this.#dependencies.tasks.cancel(key);
      return;
    }
    this.#dependencies.tasks.schedule(key, receiptGroupWakeAt(dueAt), () => this.#run(roomId));
  }

  async #run(roomId: RoomId): Promise<void> {
    const committed = await this.#dependencies.queue.run(roomId, () => {
      const record = this.#dependencies.repository.getById(roomId);
      if (record === undefined || !isPlayingRoomState(record)) return false;
      const committedAt = this.#dependencies.clock.now();
      if (!isReceiptGroupClosed(nextRoomDeadline(record), committedAt)) return false;
      const result = reconcileRoomDeadlines(record, {
        time: deadlineTime(committedAt),
        committedAt,
        identity: this.#dependencies.identity,
      });
      if (!result.changed) return false;
      return this.#dependencies.commits.commitGame({
        current: record,
        state: result.state,
      }).ok;
    });
    // Successful publication schedules the committed state inside the room queue.
    // A wake that commits nothing has still consumed its timer and must rearm.
    if (!committed) this.reconcile(roomId);
  }
}
