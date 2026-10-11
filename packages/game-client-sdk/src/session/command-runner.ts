import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  type CommandReceipt,
  GAME_COMMAND_TYPE,
  type GameCommand,
  parseCommandAck,
  parseGameCommand,
} from '@repo/game-protocol/socket';
import { type GameSnapshot, type RoomView } from '@repo/game-protocol/state';

import {
  CLIENT_ERROR_CODE,
  type ClientError,
  createProtocolError,
  createServerError,
  createTransportError,
} from '../errors';
import { waitForCommandAcknowledgement } from './command-acknowledgement';
import type { RetryPolicy } from './retry-policy';

type HoldCommand = Extract<GameCommand, { readonly type: typeof GAME_COMMAND_TYPE.SET_DIE_HELD }>;
type ScoreCommand = Extract<
  GameCommand,
  { readonly type: typeof GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY }
>;
type SuccessfulCommandData = Extract<
  ReturnType<typeof parseCommandAck>,
  { readonly ok: true }
>['data'];

export type CommandRetry = Readonly<{
  isAvailable(): boolean;
  run(): Promise<CommandResult> | null;
}>;

export type CommandResult =
  | {
      readonly ok: true;
      readonly data: CommandReceipt;
      readonly actionId: string;
      readonly requestId: string;
    }
  | { readonly ok: false; readonly error: ClientError; readonly retry?: CommandRetry };

export interface CommandRunner {
  readonly rollDice: () => Promise<CommandResult>;
  readonly setDieHeld: (slot: HoldCommand['slot'], isHeld: boolean) => Promise<CommandResult>;
  readonly selectScoreCategory: (categoryId: ScoreCommand['categoryId']) => Promise<CommandResult>;
  readonly forfeitMatch: () => Promise<CommandResult>;
}

export interface CreateCommandRunnerOptions {
  readonly retryPolicy: RetryPolicy;
  readonly createActionId: () => string;
  readonly getGame: () => GameSnapshot | null;
  readonly emit: (command: GameCommand, acknowledge: (value: unknown) => void) => void;
  readonly synchronize: (
    requireRefreshOnFailure?: boolean,
  ) => Promise<Readonly<{ ok: boolean; error?: ClientError }>>;
  readonly applySuccess: (
    data: SuccessfulCommandData,
    command: GameCommand,
  ) => AuthoritativeAcceptance;
  readonly applyRecovery: (view: RoomView) => AuthoritativeAcceptance;
  readonly signal?: AbortSignal;
  readonly getSignal?: () => AbortSignal;
}

/** Accepted views need not advance game authority or change session state or presentation. */
type AuthoritativeAcceptance = 'accepted' | 'invalid';

export function createCommandRunner(options: CreateCommandRunnerOptions): CommandRunner {
  validateRetryPolicy(options.retryPolicy);

  const run = async (
    command: GameCommand,
    expectedStateVersion: number | null,
  ): Promise<CommandResult> => {
    const signal = options.getSignal?.() ?? options.signal;
    const disposedResult = (): CommandResult => ({
      ok: false,
      error: createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED, {
        actionId: command.actionId,
      }),
    });
    const invalidResponse = async (requestId?: string): Promise<CommandResult> => {
      await options.synchronize();
      if (signal?.aborted) return disposedResult();
      return {
        ok: false,
        error: createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE, {
          actionId: command.actionId,
          ...(requestId === undefined ? {} : { requestId }),
        }),
      };
    };
    const received = await waitForCommandAcknowledgement(
      (acknowledge) => options.emit(command, acknowledge),
      options.retryPolicy,
      signal,
    );
    if (signal?.aborted || (!received.ok && received.reason === 'aborted')) {
      return disposedResult();
    }
    if (!received.ok) {
      const confirmation = await options.synchronize(true);
      if (
        signal?.aborted &&
        (confirmation.ok ||
          (confirmation.error?.kind === 'protocol' &&
            confirmation.error.code === CLIENT_ERROR_CODE.SESSION_DISPOSED))
      ) {
        return disposedResult();
      }
      // Final confirmation can publish a terminal failure whose observer disconnects.
      // The command's already established unknown outcome still belongs to this run.
      return {
        ok: false,
        error: createTransportError(CLIENT_ERROR_CODE.ACK_TIMEOUT, { actionId: command.actionId }),
      };
    }

    let ack;
    try {
      ack = parseCommandAck(received.value);
    } catch {
      return invalidResponse();
    }
    if (ack.meta.actionId !== command.actionId) {
      return invalidResponse(ack.meta.requestId);
    }
    if (ack.ok) {
      if ((command.type === GAME_COMMAND_TYPE.ROLL_DICE) !== 'roll' in ack.data.receipt) {
        return invalidResponse(ack.meta.requestId);
      }
      const application = options.applySuccess(ack.data, command);
      if (signal?.aborted) return disposedResult();
      if (application === 'invalid') {
        return invalidResponse(ack.meta.requestId);
      }
      return {
        ok: true,
        data: ack.data.receipt,
        actionId: command.actionId,
        requestId: ack.meta.requestId,
      };
    }
    let synchronized: Readonly<{ ok: boolean }> | null = null;
    if (ack.recovery !== undefined) {
      const application = options.applyRecovery(ack.recovery);
      if (signal?.aborted) return disposedResult();
      if (application === 'invalid') {
        return invalidResponse(ack.meta.requestId);
      }
    } else {
      synchronized = await options.synchronize();
      if (signal?.aborted) return disposedResult();
    }
    const rejectionCode = ack.error.code;
    const isRetryAvailable = (): boolean =>
      !signal?.aborted &&
      (rejectionCode === PUBLIC_ERROR_CODE.INTERNAL_ERROR ||
        (rejectionCode === PUBLIC_ERROR_CODE.ROLL_UNAVAILABLE &&
          isOriginalRollCurrent(command, expectedStateVersion, options.getGame())));
    const retryable = synchronized?.ok === true && isRetryAvailable();
    return {
      ok: false,
      error: createServerError(ack.error, {
        requestId: ack.meta.requestId,
        actionId: command.actionId,
      }),
      ...(retryable
        ? {
            retry: memoizeCommandRetry(isRetryAvailable, () => run(command, expectedStateVersion)),
          }
        : {}),
    };
  };

  const withTurn = (
    build: (actionId: string, turnId: string) => unknown,
  ): Promise<CommandResult> => {
    const game = options.getGame();
    if (game === null || game.match.status !== 'playing') {
      return Promise.resolve({
        ok: false,
        error: createProtocolError(CLIENT_ERROR_CODE.STATE_UNAVAILABLE),
      });
    }
    let command: GameCommand;
    try {
      command = parseGameCommand(build(options.createActionId(), game.match.currentTurn.turnId));
    } catch {
      return Promise.resolve({
        ok: false,
        error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH),
      });
    }
    return run(command, game.stateVersion);
  };

  return {
    rollDice: () =>
      withTurn((actionId, turnId) => ({ type: GAME_COMMAND_TYPE.ROLL_DICE, actionId, turnId })),
    setDieHeld: (slot, isHeld) =>
      withTurn((actionId, turnId) => ({
        type: GAME_COMMAND_TYPE.SET_DIE_HELD,
        actionId,
        turnId,
        slot,
        isHeld,
      })),
    selectScoreCategory: (categoryId) =>
      withTurn((actionId, turnId) => ({
        type: GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY,
        actionId,
        turnId,
        categoryId,
      })),
    forfeitMatch: () => {
      let command: GameCommand;
      try {
        command = parseGameCommand({
          type: GAME_COMMAND_TYPE.FORFEIT_MATCH,
          actionId: options.createActionId(),
        });
      } catch {
        return Promise.resolve({
          ok: false,
          error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH),
        });
      }
      return run(command, null);
    },
  };
}

function memoizeCommandRetry(
  isAvailable: () => boolean,
  invoke: () => Promise<CommandResult>,
): CommandRetry {
  let invocation: Promise<CommandResult> | null = null;
  return {
    isAvailable,
    run() {
      if (invocation !== null) return invocation;
      if (!isAvailable()) return null;
      invocation = invoke();
      return invocation;
    },
  };
}

function isOriginalRollCurrent(
  command: GameCommand,
  expectedStateVersion: number | null,
  game: GameSnapshot | null,
): boolean {
  return (
    command.type === GAME_COMMAND_TYPE.ROLL_DICE &&
    expectedStateVersion !== null &&
    game?.stateVersion === expectedStateVersion &&
    game.match.status === 'playing' &&
    game.match.currentTurn.turnId === command.turnId
  );
}

function validateRetryPolicy(policy: RetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.commandResponseTimeoutMs) ||
    policy.commandResponseTimeoutMs < 1 ||
    !Number.isSafeInteger(policy.retryIntervalMs) ||
    policy.retryIntervalMs < 1 ||
    !Number.isSafeInteger(policy.maximumAttempts) ||
    policy.maximumAttempts < 1 ||
    !Number.isSafeInteger(policy.synchronizationTimeoutMs) ||
    policy.synchronizationTimeoutMs < 1
  ) {
    throw new RangeError('invalid retry policy');
  }
}
