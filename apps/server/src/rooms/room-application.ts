import { type ProtocolResult, PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import type {
  CancelRoomRequest,
  CreateRoomRequest,
  JoinRoomRequest,
  ResumeRoomRequest,
} from '@repo/game-protocol/http';
import type { RoomView } from '@repo/game-protocol/socket';
import type { CompatibilityContract } from '@repo/game-protocol/version';
import type { SeatIndex } from '@repo/yacht-rules';

import type { RollCommandExecutor } from '@/roll/roll-command-executor';
import {
  ADMISSION_OPERATION_FAILURE,
  ADMISSION_OPERATION_KIND,
  AdmissionOperationRegistry,
} from '@/rooms/application/admission/admission-operation-registry';
import {
  type CancelRoomApplicationResult,
  executeCancelRoom,
} from '@/rooms/application/admission/cancel-room';
import {
  type CreateRoomApplicationResult,
  executeCreateRoom,
} from '@/rooms/application/admission/create-room';
import type { CreateRoomRateLimiter } from '@/rooms/application/admission/create-room-rate-limiter';
import {
  executeJoinRoom,
  type JoinRoomApplicationResult,
} from '@/rooms/application/admission/join-room';
import {
  executeResumeRoom,
  type ResumeRoomApplicationResult,
} from '@/rooms/application/admission/resume-room';
import { closeRoomApplicationResources } from '@/rooms/application/close-room-resources';
import {
  executeGameCommand,
  type ExecuteGameCommandInput,
  type ExecuteGameCommandResult,
} from '@/rooms/application/commands/execute-game-command';
import { PendingActionRegistry } from '@/rooms/application/commands/pending-action-registry';
import {
  type ConnectSeatInput,
  type ConnectSeatResult,
  executeConnectSeat,
} from '@/rooms/application/connections/connect-seat';
import { ConnectionRegistry } from '@/rooms/application/connections/connection-registry';
import {
  type DisconnectSeatInput,
  executeDisconnectSeat,
} from '@/rooms/application/connections/disconnect-seat';
import { RoomMaintenance } from '@/rooms/application/room-maintenance';
import type { RoomRepository } from '@/rooms/application/room-repository';
import {
  RoomStateCommitter,
  type RoomStatePublisher,
} from '@/rooms/application/room-state-committer';
import { RoomDeadlineScheduler } from '@/rooms/application/scheduling/deadline-scheduler';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import { executeSyncRoom, type SyncRoomData } from '@/rooms/application/sync-room';
import type { RoomId } from '@/rooms/domain/room-model';
import type { Clock } from '@/runtime/clock';
import type { ServerIdentity } from '@/runtime/server-identity';
import type { TaskScheduler } from '@/runtime/task-scheduler';

export interface RoomApplicationStats {
  readonly rooms: {
    readonly rooms: number;
    readonly codes: number;
    readonly actionLedgerEntries: number;
  };
  readonly pending: number;
  readonly presence: { readonly rooms: number; readonly connections: number };
  readonly retention: {
    readonly roomRequests: number;
    readonly queueRooms: number;
    readonly createAddresses: number;
  };
}

export interface RoomApplicationDependencies {
  readonly clock: Clock;
  readonly connections: ConnectionRegistry;
  readonly expectedContract: CompatibilityContract;
  readonly identity: Omit<ServerIdentity, 'createRequestId'>;
  readonly publishRoomState: RoomStatePublisher;
  readonly onRoomRemoved?: (roomId: RoomId, view: RoomView) => void;
  readonly pending: PendingActionRegistry<ExecuteGameCommandResult>;
  readonly queue: RoomTaskQueue;
  readonly rateLimiter: CreateRoomRateLimiter;
  readonly repository: RoomRepository;
  readonly readStats: () => RoomApplicationStats;
  readonly rolls: RollCommandExecutor;
  readonly tasks: TaskScheduler;
}

const ADMISSION_OPERATION_MAX_ENTRIES = 128;
const ADMISSION_OPERATION_TTL_MS = 60 * 1_000;
const ADMISSION_CAPACITY_RETRY_AFTER_MS = 1_000;

export class RoomApplication {
  readonly #admissionOperations: AdmissionOperationRegistry;
  readonly #dependencies: RoomApplicationDependencies;
  readonly #maintenance: RoomMaintenance;
  readonly #deadlines: RoomDeadlineScheduler;
  readonly #commits: RoomStateCommitter;
  #closed: boolean = false;

  public constructor(dependencies: RoomApplicationDependencies) {
    this.#dependencies = dependencies;
    this.#admissionOperations = new AdmissionOperationRegistry({
      clock: dependencies.clock,
      maxEntries: ADMISSION_OPERATION_MAX_ENTRIES,
      ttlMs: ADMISSION_OPERATION_TTL_MS,
    });
    this.#commits = new RoomStateCommitter({
      clock: dependencies.clock,
      repository: dependencies.repository,
      publishRoomState: (publication) => {
        if (!this.#closed) this.#deadlines.reconcile(publication.roomId);
        dependencies.publishRoomState(publication);
      },
      onRemoved: (roomId, view) => this.#releaseRoomResources(roomId, view),
    });
    this.#deadlines = new RoomDeadlineScheduler({
      clock: dependencies.clock,
      identity: dependencies.identity,
      queue: dependencies.queue,
      repository: dependencies.repository,
      tasks: dependencies.tasks,
      commits: this.#commits,
    });
    this.#maintenance = new RoomMaintenance({
      clock: dependencies.clock,
      queue: dependencies.queue,
      repository: dependencies.repository,
      commits: this.#commits,
    });
  }

  public async createRoom(
    request: CreateRoomRequest,
    ipAddress: string,
  ): Promise<CreateRoomApplicationResult> {
    const operation = await this.#admissionOperations.run(
      ADMISSION_OPERATION_KIND.CREATE_ROOM,
      request.operationId,
      JSON.stringify({ clientId: request.clientId, profile: request.profile }),
      async () =>
        executeCreateRoom(
          { request, ipAddress },
          {
            clock: this.#dependencies.clock,
            identity: this.#dependencies.identity,
            rateLimiter: this.#dependencies.rateLimiter,
            commits: this.#commits,
          },
        ),
      (result) => result.ok,
    );
    return operation.ok ? operation.value : admissionOperationFailure(operation.reason);
  }

  public async joinRoom(request: JoinRoomRequest): Promise<JoinRoomApplicationResult> {
    const operation = await this.#admissionOperations.run(
      ADMISSION_OPERATION_KIND.JOIN_ROOM,
      request.operationId,
      JSON.stringify({
        clientId: request.clientId,
        profile: request.profile,
        roomCode: request.roomCode,
      }),
      async () =>
        executeJoinRoom(request, {
          clock: this.#dependencies.clock,
          identity: this.#dependencies.identity,
          commits: this.#commits,
          queue: this.#dependencies.queue,
          repository: this.#dependencies.repository,
        }),
      (result) => result.ok,
    );
    return operation.ok ? operation.value : admissionOperationFailure(operation.reason);
  }

  public resumeRoom(request: ResumeRoomRequest): Promise<ResumeRoomApplicationResult> {
    return executeResumeRoom(request, {
      clock: this.#dependencies.clock,
      queue: this.#dependencies.queue,
      repository: this.#dependencies.repository,
    });
  }

  public cancelRoom(request: CancelRoomRequest): Promise<CancelRoomApplicationResult> {
    return executeCancelRoom(request, {
      queue: this.#dependencies.queue,
      repository: this.#dependencies.repository,
      commits: this.#commits,
    });
  }

  public connectSeat(input: ConnectSeatInput): Promise<ConnectSeatResult> {
    return executeConnectSeat(input, {
      connections: this.#dependencies.connections,
      expectedContract: this.#dependencies.expectedContract,
      queue: this.#dependencies.queue,
      repository: this.#dependencies.repository,
      commits: this.#commits,
    });
  }

  public disconnectSeat(input: DisconnectSeatInput): Promise<boolean> {
    return executeDisconnectSeat(input, {
      connections: this.#dependencies.connections,
      queue: this.#dependencies.queue,
      repository: this.#dependencies.repository,
      commits: this.#commits,
    });
  }

  public syncRoom(input: {
    readonly roomId: RoomId;
    readonly seatIndex: SeatIndex;
  }): Promise<ProtocolResult<SyncRoomData>> {
    return executeSyncRoom(input, {
      queue: this.#dependencies.queue,
      repository: this.#dependencies.repository,
    });
  }

  public executeGameCommand(input: ExecuteGameCommandInput): Promise<ExecuteGameCommandResult> {
    return executeGameCommand(input, {
      clock: this.#dependencies.clock,
      identity: this.#dependencies.identity,
      commits: this.#commits,
      pending: this.#dependencies.pending,
      queue: this.#dependencies.queue,
      repository: this.#dependencies.repository,
      rolls: this.#dependencies.rolls,
    });
  }

  public stats(): RoomApplicationStats {
    return this.#dependencies.readStats();
  }

  public startMaintenance(): void {
    if (this.#closed) return;
    this.#dependencies.tasks.schedule(
      'maintenance:rooms',
      this.#dependencies.clock.now() + 30_000,
      async () => {
        try {
          await this.runMaintenance();
        } finally {
          this.startMaintenance();
        }
      },
    );
  }

  public runMaintenance() {
    this.#admissionOperations.prune();
    this.#dependencies.rateLimiter.prune(this.#dependencies.clock.now());
    return this.#maintenance.execute();
  }

  #releaseRoomResources(roomId: RoomId, view: RoomView): void {
    this.#dependencies.queue.clearRoom(roomId);
    this.#dependencies.pending.clearRoom(String(roomId));
    this.#dependencies.connections.clearRoom(roomId);
    this.#deadlines.reconcile(roomId);
    this.#dependencies.onRoomRemoved?.(roomId, view);
  }

  public close(): void {
    this.#closed = true;
    this.#admissionOperations.clear();
    closeRoomApplicationResources(this.#dependencies.queue, this.#dependencies.tasks);
  }
}

function admissionOperationFailure(
  reason: (typeof ADMISSION_OPERATION_FAILURE)[keyof typeof ADMISSION_OPERATION_FAILURE],
): ProtocolResult<never> {
  return reason === ADMISSION_OPERATION_FAILURE.OPERATION_ID_REUSED
    ? { ok: false, error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST, params: {} } }
    : {
        ok: false,
        error: {
          code: PUBLIC_ERROR_CODE.RATE_LIMITED,
          params: { retryAfterMs: ADMISSION_CAPACITY_RETRY_AFTER_MS },
        },
      };
}
