import type { RoomView } from '@repo/game-protocol/socket';
import type { CompatibilityContract } from '@repo/game-protocol/version';

import type { RollCommandExecutor } from '@/roll/command-executor';
import { CreateRoomRateLimiter } from '@/rooms/admission/create-room-rate-limit';
import type { ExecuteGameCommandResult } from '@/rooms/commands/execute-game-command';
import { PendingActionRegistry } from '@/rooms/commands/pending-action-registry';
import type { RoomStatePublisher } from '@/rooms/commit';
import { ConnectionRegistry } from '@/rooms/connections/connection-registry';
import type { RoomId } from '@/rooms/domain/room-model';
import { InMemoryRoomRepository } from '@/rooms/repository';
import { RoomApplicationService } from '@/rooms/room-application';
import { closeRoomApplicationResources } from '@/rooms/room-application-lifecycle';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';
import type { Clock } from '@/runtime/clock';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import type { ServerIdentity } from '@/runtime/server-identity';
import { SystemTaskScheduler, type TaskScheduler } from '@/runtime/task-scheduler';

interface CreateRoomApplicationOptions {
  readonly clock: Clock;
  readonly expectedContract: CompatibilityContract;
  readonly identity: Omit<ServerIdentity, 'createRequestId'>;
  readonly publishRoomState: RoomStatePublisher;
  readonly onRoomRemoved?: (roomId: RoomId, view: RoomView) => void;
  readonly rolls: RollCommandExecutor;
  readonly onSchedulerError: (error: unknown) => void;
  readonly reportUnexpected?: ErrorReporter;
}

interface RoomApplicationOverrides {
  readonly repository?: InMemoryRoomRepository;
  readonly taskScheduler?: TaskScheduler;
}

export function createRoomApplication(
  options: CreateRoomApplicationOptions,
  overrides: RoomApplicationOverrides = {},
): RoomApplicationService {
  let tasks: TaskScheduler | null = null;
  let queue: InMemoryRoomTaskQueue | null = null;
  try {
    tasks =
      overrides.taskScheduler ?? new SystemTaskScheduler(options.clock, options.onSchedulerError);
    queue = new InMemoryRoomTaskQueue({ clock: options.clock, tasks });
    const repository = overrides.repository ?? new InMemoryRoomRepository();
    const connections = new ConnectionRegistry();
    const pending = new PendingActionRegistry<ExecuteGameCommandResult>();
    const rateLimiter = new CreateRoomRateLimiter();
    const roomQueue = queue;
    return new RoomApplicationService({
      clock: options.clock,
      connections,
      expectedContract: options.expectedContract,
      identity: options.identity,
      pending,
      queue,
      rateLimiter,
      repository,
      readStats: () => ({
        rooms: repository.telemetryCounts(),
        pending: pending.totalCount(),
        presence: connections.counts(),
        retention: {
          roomRequests: roomQueue.pendingRequestCount,
          queueRooms: roomQueue.activeRoomCount,
          createAddresses: rateLimiter.trackedAddressCount,
        },
      }),
      rolls: options.rolls,
      tasks,
      publishRoomState: options.publishRoomState,
      onRoomRemoved: options.onRoomRemoved,
    });
  } catch (error) {
    try {
      closeRoomApplicationResources(queue, tasks);
    } catch (cleanupError) {
      reportUnexpected(options.reportUnexpected, cleanupError, 'shutdown');
    }
    throw error;
  }
}
