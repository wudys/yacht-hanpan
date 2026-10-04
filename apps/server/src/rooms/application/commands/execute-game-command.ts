import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
  type PublicError,
  type PublicErrorCode,
} from '@repo/game-protocol/errors';
import { GAME_COMMAND_TYPE, type GameCommand, type RoomView } from '@repo/game-protocol/socket';
import type { SeatIndex } from '@repo/yacht-rules';

import type { RollCommandExecutor } from '@/roll/roll-command-executor';
import {
  type ActionLedgerEntry,
  compactActionLedger,
  findAction,
  fingerprintGameCommand,
  type LogicalActionDecision,
  type LogicalActionResult,
  reserveRetryableAction,
  type SuccessfulLogicalActionResult,
} from '@/rooms/application/commands/action-ledger';
import { captureCommandTime } from '@/rooms/application/commands/command-time';
import type { PendingActionRegistry } from '@/rooms/application/commands/pending-action-registry';
import { projectRoomView } from '@/rooms/application/projection/room-view';
import {
  mapCommitFailure,
  mapMatchRejection,
  mapRollFailure,
} from '@/rooms/application/public-error-mapping';
import { reconcileRoomDeadlines } from '@/rooms/application/reconcile-room-deadlines';
import type { RoomRepositoryReader } from '@/rooms/application/room-repository';
import type { CommitFailure, RoomStateCommitter } from '@/rooms/application/room-state-committer';
import type { RoomTaskQueue } from '@/rooms/application/scheduling/room-task-queue';
import type { RoomCommandTime } from '@/rooms/domain/event-time';
import {
  applyRollResult,
  forfeitMatch,
  type MatchTransition,
  planRoll,
  selectScoreCategory,
  setDieHeld,
  turnId,
} from '@/rooms/domain/match';
import { finishRoomMatch } from '@/rooms/domain/room-match-lifecycle';
import type { RoomId } from '@/rooms/domain/room-model';
import {
  type FinishedRoomState,
  isPlayingRoomState,
  type PlayingRoomState,
} from '@/rooms/domain/room-state';
import { epochMilliseconds } from '@/rooms/domain/time';
import type { Clock } from '@/runtime/clock';
import type { ServerIdentity } from '@/runtime/server-identity';

export type CommandApplicationResult =
  | ProtocolResult<
      Readonly<{
        receipt: Omit<SuccessfulLogicalActionResult, 'ok'>;
        view: RoomView;
      }>
    >
  | {
      readonly ok: false;
      readonly error: PublicError;
      readonly recovery: RoomView;
    };

export interface ExecuteGameCommandResult {
  readonly result: CommandApplicationResult;
  readonly committedStateVersion: number | null;
}

export interface ExecuteGameCommandInput {
  readonly roomId: RoomId;
  readonly seatIndex: SeatIndex;
  readonly command: GameCommand;
  readonly receivedAt: number;
}

export interface ExecuteGameCommandDependencies {
  readonly clock: Clock;
  readonly identity: Pick<ServerIdentity, 'createTurnId'>;
  readonly commits: Pick<RoomStateCommitter, 'commitGame' | 'commitLedger'>;
  readonly pending: PendingActionRegistry<ExecuteGameCommandResult>;
  readonly queue: RoomTaskQueue;
  readonly repository: RoomRepositoryReader;
  readonly rolls: RollCommandExecutor;
}

export async function executeGameCommand(
  input: ExecuteGameCommandInput,
  dependencies: ExecuteGameCommandDependencies,
): Promise<ExecuteGameCommandResult> {
  const commandTime = captureCommandTime(input.command.type, input.receivedAt);
  const fingerprint = fingerprintGameCommand(input.command);
  const key = `${input.seatIndex}:${input.command.actionId}`;
  const pending = await dependencies.pending.run(
    String(input.roomId),
    key,
    fingerprint,
    async () => {
      const admitted = await dependencies.queue.runRequest(
        input.roomId,
        () => executeSerialized(input, fingerprint, commandTime, dependencies),
        commandTime,
      );
      return admitted.ok ? admitted.value : rateLimited();
    },
  );
  if (pending.kind === 'conflict') return failure(PUBLIC_ERROR_CODE.ACTION_ID_REUSED);
  if (pending.kind === 'saturated') return rateLimited();
  return pending.owner ? pending.result : { ...pending.result, committedStateVersion: null };
}

async function executeSerialized(
  input: ExecuteGameCommandInput,
  fingerprint: string,
  commandTime: RoomCommandTime,
  dependencies: ExecuteGameCommandDependencies,
): Promise<ExecuteGameCommandResult> {
  const checkedAt = dependencies.clock.now();
  const found = dependencies.repository.getById(input.roomId);
  if (found === undefined) {
    return failure(PUBLIC_ERROR_CODE.MATCH_FINISHED);
  }
  const stored = found;

  const compacted = compactActionLedger(stored.actionLedger, checkedAt);
  const existing = findAction(compacted, input.seatIndex, input.command.actionId);
  if (existing !== undefined) {
    if (existing.fingerprint !== fingerprint) return failure(PUBLIC_ERROR_CODE.ACTION_ID_REUSED);
    if (existing.status === 'completed')
      return {
        result: logicalToApplication(existing.result, projectRoomView(stored)),
        committedStateVersion: null,
      };
    if (existing.status === 'tombstone') {
      if (stored.match === null) return failure(PUBLIC_ERROR_CODE.MATCH_FINISHED);
      const result: CommandApplicationResult = {
        ok: false,
        error: createPublicError(PUBLIC_ERROR_CODE.ACTION_RESULT_EXPIRED, {}),
        recovery: projectRoomView(stored),
      };
      if (compacted === stored.actionLedger) return { result, committedStateVersion: null };
      const committed = dependencies.commits.commitLedger({
        current: stored,
        actionLedger: compacted,
      });
      return committed.ok
        ? { result, committedStateVersion: committed.committedStateVersion }
        : failureForCommit(committed.reason);
    }
  }

  if (!isPlayingRoomState(stored)) {
    return failure(PUBLIC_ERROR_CODE.MATCH_FINISHED);
  }

  const playing = stored;
  const commitAt = dependencies.clock.now();
  const automatic = reconcileRoomDeadlines(stored, {
    time: commandTime,
    committedAt: commitAt,
    identity: dependencies.identity,
  });
  if (!isPlayingRoomState(automatic.state)) {
    return commitState(automatic.state, true, failure(PUBLIC_ERROR_CODE.MATCH_FINISHED).result);
  }
  const current = automatic.state;

  if (input.command.type === GAME_COMMAND_TYPE.ROLL_DICE) {
    return executeRollCommand(input.command);
  }

  const transition = transitionForCommand(
    current,
    input.command,
    input.seatIndex,
    input.receivedAt,
    commitAt,
    dependencies.identity,
  );
  if (!transition.ok) {
    const logical: LogicalActionDecision = {
      ok: false,
      error: createPublicError(mapMatchRejection(transition.code), {}),
    };
    return completeCommand(current, logical, automatic.changed);
  }

  const commandState = transition.changed
    ? stateAfterTransition(current, transition, commitAt)
    : current;
  if (commandState === null) return failure(PUBLIC_ERROR_CODE.INTERNAL_ERROR);
  // Equality remains open for a same-time score or forfeit. The deadline scheduler closes
  // that millisecond; earlier connection deadlines were already applied above.
  return completeCommand(commandState, { ok: true }, automatic.changed || transition.changed);

  async function executeRollCommand(
    command: Extract<GameCommand, { readonly type: 'rollDice' }>,
  ): Promise<ExecuteGameCommandResult> {
    const planned = planRoll(current.match, {
      seatIndex: input.seatIndex,
      turnId: turnId(command.turnId),
      receivedAt: epochMilliseconds(input.receivedAt),
    });
    if (!planned.ok) {
      const logical: LogicalActionDecision = {
        ok: false,
        error: createPublicError(mapMatchRejection(planned.code), {}),
      };
      return completeCommand(current, logical, automatic.changed);
    }

    const ledger = reserveRetryableAction(compacted, {
      seatIndex: input.seatIndex,
      actionId: input.command.actionId,
      fingerprint,
    });
    if (ledger === null) return refuseCapacity();

    const roll = await dependencies.rolls.execute({ rolledSlots: planned.value.rollingSlots });
    if (roll.ok) {
      const transition = applyRollResult(current.match, {
        plan: planned.value,
        facesBySlot: roll.artifact.outcome.authoritativeValuesBySlot,
      });
      if (!transition.ok) {
        return failure(PUBLIC_ERROR_CODE.INTERNAL_ERROR);
      }
      const commandState = stateAfterTransition(current, transition, commitAt);
      if (commandState === null) return failure(PUBLIC_ERROR_CODE.INTERNAL_ERROR);
      return completeCommand(commandState, { ok: true, roll: roll.artifact }, true);
    }

    return commitState(
      current,
      automatic.changed,
      {
        ok: false,
        error: mapRollFailure(roll.reason),
      },
      ledger,
    );
  }

  function completeCommand(
    state: PlayingRoomState | FinishedRoomState,
    logical: LogicalActionDecision,
    changed: boolean,
  ): ExecuteGameCommandResult {
    const completedAction = {
      seatIndex: input.seatIndex,
      actionId: input.command.actionId,
      fingerprint,
      result: logical,
    };
    const committed = changed
      ? dependencies.commits.commitGame({
          current: playing,
          state,
          actionLedger: compacted,
          completedAction,
        })
      : dependencies.commits.commitLedger({
          current: stored,
          actionLedger: compacted,
          completedAction,
        });
    return committed.ok
      ? {
          result: logicalToApplication(
            committed.actionResult,
            'view' in committed ? committed.view : projectRoomView(committed.record),
          ),
          committedStateVersion: committed.committedStateVersion,
        }
      : committed.reason === 'ledgerCapacity'
        ? refuseCapacity()
        : failureForCommit(committed.reason);
  }

  function refuseCapacity(): ExecuteGameCommandResult {
    return automatic.changed ? commitState(current, true, rateLimited().result) : rateLimited();
  }

  function commitState(
    state: PlayingRoomState | FinishedRoomState,
    changed: boolean,
    result: CommandApplicationResult,
    actionLedger: readonly ActionLedgerEntry[] = compacted,
  ): ExecuteGameCommandResult {
    const committed = changed
      ? dependencies.commits.commitGame({ current: playing, state, actionLedger })
      : dependencies.commits.commitLedger({ current: playing, actionLedger });
    return committed.ok
      ? { result, committedStateVersion: committed.committedStateVersion }
      : failureForCommit(committed.reason);
  }
}

function transitionForCommand(
  current: PlayingRoomState,
  command: Exclude<GameCommand, { readonly type: 'rollDice' }>,
  seatIndex: SeatIndex,
  receivedAt: number,
  commitAt: number,
  identity: Pick<ServerIdentity, 'createTurnId'>,
): MatchTransition {
  switch (command.type) {
    case GAME_COMMAND_TYPE.SET_DIE_HELD:
      return setDieHeld(current.match, {
        seatIndex: seatIndex,
        turnId: turnId(command.turnId),
        receivedAt: epochMilliseconds(receivedAt),
        slot: command.slot,
        isHeld: command.isHeld,
      });
    case GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY:
      return selectScoreCategory(current.match, {
        seatIndex: seatIndex,
        turnId: turnId(command.turnId),
        receivedAt: epochMilliseconds(receivedAt),
        categoryId: command.categoryId,
        nextTurn: {
          id: turnId(identity.createTurnId()),
          startedAt: epochMilliseconds(commitAt),
        },
      });
    case GAME_COMMAND_TYPE.FORFEIT_MATCH:
      return forfeitMatch(current.match, {
        forfeitingSeatIndex: seatIndex,
      });
  }
}

function stateAfterTransition(
  current: PlayingRoomState,
  transition: Extract<MatchTransition, { readonly ok: true }>,
  committedAt: number,
): PlayingRoomState | FinishedRoomState | null {
  if (transition.match.status === 'playing') {
    return { room: current.room, match: transition.match };
  }
  const finished = finishRoomMatch(current, transition.match, committedAt);
  return finished.ok ? finished.state : null;
}

function logicalToApplication(
  logical: LogicalActionResult,
  view: RoomView,
): CommandApplicationResult {
  return logical.ok
    ? {
        ok: true,
        data: {
          receipt: {
            stateVersion: logical.stateVersion,
            ...(logical.roll ? { roll: logical.roll } : {}),
          },
          view,
        },
      }
    : { ok: false, error: logical.error };
}

function failureForCommit(reason: CommitFailure['reason']): ExecuteGameCommandResult {
  return {
    result: { ok: false, error: mapCommitFailure(reason) },
    committedStateVersion: null,
  };
}

function failure(code: PublicErrorCode): ExecuteGameCommandResult {
  if (code === PUBLIC_ERROR_CODE.RATE_LIMITED) return rateLimited();
  return {
    result: {
      ok: false,
      error: createPublicError(code, {}),
    },
    committedStateVersion: null,
  };
}

function rateLimited(): ExecuteGameCommandResult {
  return {
    result: {
      ok: false,
      error: createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 }),
    },
    committedStateVersion: null,
  };
}
