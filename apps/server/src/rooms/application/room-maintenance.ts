import { compactActionLedger } from '@/rooms/application/commands/action-ledger';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { RoomStateCommitter } from '@/rooms/application/room-state-committer';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { evaluateCleanup } from '@/rooms/domain/cleanup-policy';
import type { RoomId } from '@/rooms/domain/room-model';
import type { Clock } from '@/runtime/clock';

export interface RoomMaintenanceDependencies {
  readonly clock: Clock;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly commits: Pick<RoomStateCommitter, 'commitLedger' | 'remove'>;
}

export class RoomMaintenance {
  readonly #dependencies: RoomMaintenanceDependencies;
  #inFlight: Promise<void> | null = null;

  public constructor(dependencies: RoomMaintenanceDependencies) {
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
    let failed = false;
    let firstFailure: unknown;
    const recordFailure = (error: unknown): void => {
      if (failed) return;
      failed = true;
      firstFailure = error;
    };
    const candidates = roomIds.map((roomId: RoomId) => {
      try {
        return this.#dependencies.queue
          .run(roomId, () => this.#cleanupOne(roomId, checkedAt))
          .catch(recordFailure);
      } catch (error) {
        recordFailure(error);
        return Promise.resolve();
      }
    });
    await Promise.all(candidates);
    if (failed) throw firstFailure;
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
