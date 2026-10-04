import {
  type CommittedRoomUpdate,
  type GameSnapshot,
  parseCommittedRoomUpdate,
  ROOM_UPDATE_TYPE,
  type RoomView,
} from '@repo/game-protocol/socket';
import type { SeatIndex } from '@repo/yacht-rules';

import {
  type ActionIdentity,
  type ActionLedgerEntry,
  completeAction,
  type LogicalActionDecision,
  type LogicalActionResult,
} from '@/rooms/application/commands/action-ledger';
import type {
  ActiveConnectionRegistry,
  ActiveSeatConnection,
} from '@/rooms/application/connections/connection-registry';
import type { SeatTokenHash } from '@/rooms/application/connections/seat-token';
import { projectRoomView } from '@/rooms/application/projection/room-view';
import {
  applyPresenceToRoomRecord,
  type FinishedRoomRecord,
  type PlayingRoomRecord,
  type RoomRecord,
  type WaitingRoomRecord,
} from '@/rooms/application/room-record';
import type { CreateRecordResult, RoomRepository } from '@/rooms/application/room-repository';
import type { Room, RoomId } from '@/rooms/domain/room-model';
import {
  type FinishedRoomState,
  isPlayingRoomState,
  type PlayingRoomState,
} from '@/rooms/domain/room-state';
import type { Clock } from '@/runtime/clock';

type GameRoomView = RoomView & Readonly<{ game: GameSnapshot }>;

export type RoomStatePublication =
  | Readonly<{ kind: 'started'; roomId: RoomId; update: CommittedRoomUpdate }>
  | Readonly<{ kind: 'game'; roomId: RoomId; update: CommittedRoomUpdate }>
  | Readonly<{ kind: 'presence'; roomId: RoomId; update: CommittedRoomUpdate }>;

// undefined rejects Promise-returning implementations: publication finishes before queue release.
export type RoomStatePublisher = (publication: RoomStatePublication) => undefined;

interface CompletedActionDecision extends ActionIdentity {
  readonly result: LogicalActionDecision;
}

interface StorageFailure {
  readonly ok: false;
  readonly reason: 'storageFailure';
}

export type CommitFailure = StorageFailure | Readonly<{ ok: false; reason: 'ledgerCapacity' }>;

interface GameCommitInput {
  readonly current: PlayingRoomRecord;
  readonly state: PlayingRoomState | FinishedRoomState;
  readonly actionLedger?: readonly ActionLedgerEntry[];
  readonly completedAction?: CompletedActionDecision;
}

interface LedgerCommitInput {
  readonly current: RoomRecord;
  readonly actionLedger: readonly ActionLedgerEntry[];
  readonly completedAction?: CompletedActionDecision;
}

interface GameCommitSuccess {
  readonly ok: true;
  readonly record: PlayingRoomRecord | FinishedRoomRecord;
  readonly view: GameRoomView;
  readonly committedStateVersion: number;
}

interface LedgerCommitSuccess {
  readonly ok: true;
  readonly record: RoomRecord;
  readonly committedStateVersion: null;
}

interface PresenceCommitSuccess {
  readonly ok: true;
  readonly record: RoomRecord;
  readonly view: RoomView;
  readonly presenceChanged: boolean;
}

interface RoomStateCommitterDependencies {
  readonly clock: Clock;
  readonly repository: RoomRepository;
  readonly publishRoomState: RoomStatePublisher;
  readonly onRemoved?: (roomId: RoomId, view: RoomView) => void;
}

export class RoomStateCommitter {
  readonly #dependencies: RoomStateCommitterDependencies;

  public constructor(dependencies: RoomStateCommitterDependencies) {
    this.#dependencies = dependencies;
  }

  public create(
    record: WaitingRoomRecord,
  ): Readonly<{ ok: true; view: RoomView }> | Extract<CreateRecordResult, { readonly ok: false }> {
    const view = projectRoomView(record);
    const stored = this.#dependencies.repository.createExclusive(record);
    return stored.ok ? { ok: true, view } : stored;
  }

  public commitStart(
    input: Readonly<{
      current: WaitingRoomRecord;
      state: PlayingRoomState;
      guestCredentialHash: SeatTokenHash;
    }>,
  ): GameCommitSuccess | StorageFailure {
    const record: PlayingRoomRecord = {
      room: input.state.room,
      match: input.state.match,
      credentialHashes: [input.current.credentialHashes[0], input.guestCredentialHash],
      presenceVersion: input.current.presenceVersion + 1,
      stateVersion: input.current.stateVersion + 1,
      actionLedger: input.current.actionLedger,
    };
    return this.#storeGame(input.current.room.id, record, 'started');
  }

  public commitGame(
    input: GameCommitInput & { readonly completedAction: CompletedActionDecision },
  ): (GameCommitSuccess & Readonly<{ actionResult: LogicalActionResult }>) | CommitFailure;
  public commitGame(
    input: Omit<GameCommitInput, 'completedAction'>,
  ): GameCommitSuccess | StorageFailure;
  public commitGame(
    input: GameCommitInput,
  ): (GameCommitSuccess & Readonly<{ actionResult?: LogicalActionResult }>) | CommitFailure {
    const stateVersion = input.current.stateVersion + 1;
    const completed = this.#completeLedger(
      input.actionLedger ?? input.current.actionLedger,
      input.completedAction,
      stateVersion,
    );
    if (!completed.ok) return completed;
    const metadata = {
      credentialHashes: input.current.credentialHashes,
      presenceVersion: input.current.presenceVersion,
      actionLedger: completed.actionLedger,
      stateVersion,
    };
    const record = isPlayingRoomState(input.state)
      ? { room: input.state.room, match: input.state.match, ...metadata }
      : { room: input.state.room, match: input.state.match, ...metadata };
    return this.#storeGame(input.current.room.id, record, 'game', completed.actionResult);
  }

  public commitLedger(
    input: LedgerCommitInput & { readonly completedAction: CompletedActionDecision },
  ): (LedgerCommitSuccess & Readonly<{ actionResult: LogicalActionResult }>) | CommitFailure;
  public commitLedger(input: LedgerCommitInput): LedgerCommitSuccess | CommitFailure;
  public commitLedger(
    input: LedgerCommitInput,
  ): (LedgerCommitSuccess & Readonly<{ actionResult?: LogicalActionResult }>) | CommitFailure {
    const completed = this.#completeLedger(
      input.actionLedger,
      input.completedAction,
      input.current.stateVersion,
    );
    if (!completed.ok) return completed;
    const record = { ...input.current, actionLedger: completed.actionLedger };
    if (
      completed.actionLedger !== input.current.actionLedger &&
      !this.#dependencies.repository.replace(input.current.room.id, record)
    ) {
      return { ok: false, reason: 'storageFailure' };
    }
    return {
      ok: true,
      record,
      committedStateVersion: null,
      ...(completed.actionResult === undefined ? {} : { actionResult: completed.actionResult }),
    };
  }

  public commitPresence(
    input: Readonly<{ current: RoomRecord; room: Room }>,
  ): PresenceCommitSuccess | StorageFailure {
    const committed = this.#storePresence(input);
    if (committed.ok && committed.presenceChanged) {
      this.#dependencies.publishRoomState({
        kind: 'presence',
        roomId: committed.record.room.id,
        update: parseCommittedRoomUpdate({
          type: ROOM_UPDATE_TYPE.STATE_COMMITTED,
          view: committed.view,
        }),
      });
    }
    return committed;
  }

  public commitSeatConnection(
    input: Readonly<{
      current: RoomRecord;
      room: Room;
      seatIndex: SeatIndex;
      connection: ActiveSeatConnection;
    }>,
    connections: Pick<ActiveConnectionRegistry, 'bind'>,
  ): PresenceCommitSuccess | StorageFailure {
    const committed = this.#storePresence(input);
    if (!committed.ok) return committed;
    connections.bind(committed.record.room.id, input.seatIndex, input.connection);
    if (committed.presenceChanged) {
      this.#dependencies.publishRoomState({
        kind: 'presence',
        roomId: committed.record.room.id,
        update: parseCommittedRoomUpdate({
          type: ROOM_UPDATE_TYPE.STATE_COMMITTED,
          view: committed.view,
        }),
      });
    }
    return committed;
  }

  public remove(current: RoomRecord): boolean {
    const view = projectRoomView(current);
    if (this.#dependencies.repository.remove(current.room.id) === undefined) return false;
    this.#dependencies.onRemoved?.(current.room.id, view);
    return true;
  }

  #storeGame(
    roomId: RoomId,
    record: PlayingRoomRecord | FinishedRoomRecord,
    kind: 'started' | 'game',
    actionResult?: LogicalActionResult,
  ): (GameCommitSuccess & Readonly<{ actionResult?: LogicalActionResult }>) | StorageFailure {
    const view = projectRoomView(record);
    const roll = actionResult?.ok ? actionResult.roll : undefined;
    // Validate coherence before storage and give publication its own detached DTO.
    const update = parseCommittedRoomUpdate(
      roll === undefined
        ? { type: ROOM_UPDATE_TYPE.STATE_COMMITTED, view }
        : { type: ROOM_UPDATE_TYPE.ROLL_COMMITTED, view, roll },
    );
    if (!this.#dependencies.repository.replace(roomId, record)) {
      return { ok: false, reason: 'storageFailure' };
    }
    this.#dependencies.publishRoomState({ kind, roomId: record.room.id, update });
    return {
      ok: true,
      record,
      view,
      committedStateVersion: record.stateVersion,
      ...(actionResult === undefined ? {} : { actionResult }),
    };
  }

  #storePresence(
    input: Readonly<{ current: RoomRecord; room: Room }>,
  ): PresenceCommitSuccess | StorageFailure {
    const presenceChanged = input.room !== input.current.room;
    const record = applyPresenceToRoomRecord(input.current, {
      ok: true,
      changed: presenceChanged,
      room: input.room,
    });
    if (record === null) return { ok: false, reason: 'storageFailure' };
    const view = projectRoomView(record);
    if (presenceChanged && !this.#dependencies.repository.replace(input.current.room.id, record)) {
      return { ok: false, reason: 'storageFailure' };
    }
    return { ok: true, record, view, presenceChanged };
  }

  #completeLedger(
    actionLedger: readonly ActionLedgerEntry[],
    decision: CompletedActionDecision | undefined,
    stateVersion: number,
  ):
    | Readonly<{
        ok: true;
        actionLedger: readonly ActionLedgerEntry[];
        actionResult?: LogicalActionResult;
      }>
    | CommitFailure {
    if (decision === undefined) return { ok: true, actionLedger };
    const { result, ...identity } = decision;
    const actionResult: LogicalActionResult = result.ok ? { ...result, stateVersion } : result;
    const completed = completeAction(actionLedger, {
      ...identity,
      result: actionResult,
      completedAt: this.#dependencies.clock.now(),
    });
    return completed === null
      ? { ok: false, reason: 'ledgerCapacity' }
      : { ok: true, actionLedger: completed, actionResult };
  }
}
