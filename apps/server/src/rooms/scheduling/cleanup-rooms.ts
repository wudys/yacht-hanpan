import { compactActionLedger } from '@/rooms/commands/action-ledger';
import type { RoomStateCommitter } from '@/rooms/commit';
import { evaluateCleanup } from '@/rooms/domain/cleanup-policy';
import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomRepositoryReader } from '@/rooms/repository';
import type { RoomTaskQueue } from '@/rooms/scheduling/room-task-queue';
import type { Clock } from '@/runtime/clock';

export interface CleanupRoomsUseCaseDependencies {
  readonly clock: Clock;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly commits: Pick<RoomStateCommitter, 'commitLedger' | 'remove'>;
}

export class CleanupRoomsUseCase {
  readonly #dependencies: CleanupRoomsUseCaseDependencies;
  #inFlight: Promise<void> | null = null;

  public constructor(dependencies: CleanupRoomsUseCaseDependencies) {
    this.#dependencies = dependencies;
  }

  public execute(): Promise<void> {
    if (this.#inFlight !== null) return this.#inFlight;
    this.#inFlight = this.#cleanupCandidates().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #cleanupCandidates(): Promise<void> {
    const checkedAt: number = this.#dependencies.clock.now();
    const roomIds = this.#dependencies.repository.listMaintenanceCandidateRoomIds(checkedAt);
    await Promise.all(
      roomIds.map((roomId: RoomId) =>
        this.#dependencies.queue.run(roomId, () => this.#cleanupOne(roomId, checkedAt)),
      ),
    );
  }

  #cleanupOne(roomId: RoomId, checkedAt: number): void {
    const current = this.#dependencies.repository.getById(roomId);
    if (current === undefined) return;
    const evaluated = evaluateCleanup(current.room, { checkedAt });
    if (!evaluated.ok || evaluated.reason === null) {
      const compacted = compactActionLedger(current.actionLedger, checkedAt);
      if (compacted !== current.actionLedger) {
        this.#dependencies.commits.commitLedger({ current, actionLedger: compacted });
      }
      return;
    }
    this.#dependencies.commits.remove(current);
  }
}
