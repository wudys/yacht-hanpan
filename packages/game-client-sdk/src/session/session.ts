import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import {
  type GameSnapshot,
  parseCommittedRoomUpdate,
  parseSocketConnectionFailure,
  type PresenceSnapshot,
  type PublicRoom,
  type RoomView,
  SOCKET_CONNECTION_INTENT,
} from '@repo/game-protocol/socket';
import type { CompatibilityContract } from '@repo/game-protocol/version';
import { v4 as uuidV4, v7 as uuidV7 } from 'uuid';

import {
  CLIENT_ERROR_CODE,
  type ClientError,
  createConnectionError,
  createProtocolError,
  createTransportError,
} from '../errors';
import type { GameSocketFactory, RoomAuthority } from '../ports';
import type { ServerClock } from '../server-clock';
import { socketIoGameSocketFactory } from '../socket/socket-io-adapter';
import { type CommandResult, type CommandRunner, createCommandRunner } from './command-runner';
import { GAME_CLIENT_RETRY_POLICY, type RetryPolicy } from './retry-policy';
import { requestSync } from './sync-request';
import {
  createSessionState,
  type GamePresentation,
  reduceCommandView,
  reduceCommittedUpdate,
  reduceRestoredView,
  type SessionState,
} from './update-reducer';

export type { GamePresentation, ScoreRecord } from './update-reducer';

export type ConnectionStatus =
  'idle' | 'connecting' | 'connected' | 'disconnected' | 'replaced' | 'disposed';

export interface GameSessionSnapshot {
  readonly room: PublicRoom | null;
  readonly connection: ConnectionStatus;
  readonly syncStatus: 'idle' | 'synchronizing';
  readonly syncRevision: number;
  readonly game: GameSnapshot | null;
  readonly presence: PresenceSnapshot | null;
  readonly presentation: GamePresentation | null;
  readonly error: ClientError | null;
}

export interface GameSession {
  readonly connect: () => Promise<SessionOperationResult>;
  readonly disconnect: () => void;
  readonly dispose: () => void;
  readonly synchronize: () => Promise<SessionOperationResult>;
  readonly getSnapshot: () => GameSessionSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly rollDice: () => Promise<CommandResult>;
  readonly setDieHeld: CommandRunner['setDieHeld'];
  readonly selectScoreCategory: CommandRunner['selectScoreCategory'];
  readonly forfeitMatch: () => Promise<CommandResult>;
}

export type SessionOperationResult =
  { readonly ok: true } | { readonly ok: false; readonly error: ClientError };

export interface CreateGameSessionOptions {
  readonly clock?: ServerClock;
  readonly socketUrl: string;
  readonly authority: RoomAuthority;
  readonly contract: CompatibilityContract;
  readonly socketFactory?: GameSocketFactory;
  readonly retryPolicy?: RetryPolicy;
  readonly createActionId?: () => string;
}

export function createGameSession(options: CreateGameSessionOptions): GameSession {
  let state = createSessionState();
  let connection: ConnectionStatus = 'idle';
  let lastError: ClientError | null = null;
  let disposed = false;
  let syncStatus: GameSessionSnapshot['syncStatus'] = 'idle';
  let syncRevision = 0;
  let activeSynchronization: {
    readonly controller: AbortController;
    readonly promise: Promise<SessionOperationResult>;
  } | null = null;
  let connectionSync: Promise<SessionOperationResult> | null = null;
  let connectPromise: Promise<SessionOperationResult> | null = null;
  let connectionAttempt: {
    readonly controller: AbortController;
    error: ClientError | null;
  } | null = null;
  let connectionRevision = 0;
  let disconnecting = false;
  let connectionEventsEnabled = false;
  const lifecycle = new AbortController();
  let snapshot = createSnapshot();
  const subscribers = new Set<() => void>();
  const executionId = uuidV4();
  let firstAuthentication = true;
  const socket = (options.socketFactory ?? socketIoGameSocketFactory).create({
    url: options.socketUrl,
    getAuth: () => {
      const connectionIntent = firstAuthentication
        ? SOCKET_CONNECTION_INTENT.ENTER
        : SOCKET_CONNECTION_INTENT.RECONNECT;
      // Consume takeover on transmission, including when its response is lost.
      firstAuthentication = false;
      return {
        roomId: options.authority.roomId,
        seatToken: options.authority.seatToken,
        contract: options.contract,
        executionId,
        connectionIntent,
      };
    },
  });

  const publish = (): void => {
    snapshot = createSnapshot();
    for (const subscriber of subscribers) subscriber();
  };

  const replaceState = (next: SessionState): void => {
    state = next;
    lastError = null;
    publish();
  };

  const validAuthorityView = (incoming: RoomView): boolean =>
    incoming.room.roomId === options.authority.roomId &&
    incoming.room.seats[options.authority.seatIndex] !== undefined;

  const synchronize = (): Promise<SessionOperationResult> => {
    if (lifecycle.signal.aborted) {
      return Promise.resolve({
        ok: false,
        error: createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED),
      });
    }
    if (activeSynchronization !== null) return activeSynchronization.promise;
    const controller = new AbortController();
    const clockSample = options.clock?.beginSample();
    syncStatus = 'synchronizing';
    const pending = requestSync({
      timeoutMs: (options.retryPolicy ?? GAME_CLIENT_RETRY_POLICY).acknowledgementTimeoutMs,
      emit: (acknowledge) => socket.emitSync(acknowledge),
      signal: controller.signal,
    }).then((response): SessionOperationResult => {
      if (lifecycle.signal.aborted || activeSynchronization?.promise !== pending) {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED) };
      }
      let result: SessionOperationResult;
      if (!response.ok) {
        result = response;
      } else {
        const reduction = validAuthorityView(response.data)
          ? reduceRestoredView(state, response.data)
          : { kind: 'invalid' as const };
        if (reduction.kind === 'invalid') {
          result = {
            ok: false,
            error: createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE, {
              requestId: response.meta.requestId,
            }),
          };
        } else {
          if (clockSample) options.clock?.acceptSample(clockSample, response.meta.serverTime);
          state = reduction.state;
          lastError = null;
          syncRevision += 1;
          result = { ok: true };
        }
      }
      if (!result.ok) lastError = result.error;
      activeSynchronization = null;
      syncStatus = 'idle';
      publish();
      return result;
    });
    activeSynchronization = { controller, promise: pending };
    publish();
    return pending;
  };

  const cancelSynchronization = (): void => {
    const active = activeSynchronization;
    activeSynchronization = null;
    active?.controller.abort();
    syncStatus = 'idle';
  };

  const cancelConnectionAttempt = (error: ClientError): void => {
    const attempt = connectionAttempt;
    connectionAttempt = null;
    connectPromise = null;
    if (attempt === null) return;
    attempt.error = error;
    attempt.controller.abort();
  };

  const acceptConnected = (): Promise<SessionOperationResult> => {
    if (connection === 'connected') return connectionSync ?? synchronize();
    connection = 'connected';
    lastError = null;
    const revision = ++connectionRevision;
    const synchronization = synchronize();
    // Synchronization publishes synchronously; subscribers may close or replace this connection.
    if (revision === connectionRevision && !lifecycle.signal.aborted) {
      connectionSync = synchronization;
    }
    return synchronization;
  };

  const acceptDisconnected = (): boolean => {
    const changed = connection !== 'disconnected' || syncStatus !== 'idle';
    cancelConnectionAttempt(createTransportError(CLIENT_ERROR_CODE.SOCKET_DISCONNECTED));
    connectionRevision += 1;
    connectionSync = null;
    cancelSynchronization();
    connection = 'disconnected';
    return changed;
  };

  const synchronizeIfConnected = (): void => {
    if (connection === 'connected') void synchronize();
  };
  function handleSessionReplaced(): void {
    if (lifecycle.signal.aborted) return;
    connection = 'replaced';
    lastError = null;
    lifecycle.abort();
    cancelConnectionAttempt(createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED));
    connectionRevision += 1;
    connectionSync = null;
    cancelSynchronization();
    socket.dispose();
    publish();
  }

  const unsubscriptions = [
    socket.onReplaced(handleSessionReplaced),
    socket.onConnected(() => {
      if (
        lifecycle.signal.aborted ||
        connection === 'connected' ||
        disconnecting ||
        !connectionEventsEnabled
      )
        return;
      void acceptConnected();
    }),
    socket.onDisconnected(() => {
      if (lifecycle.signal.aborted || disconnecting) return;
      if (acceptDisconnected()) publish();
    }),
    socket.onConnectionError((value) => {
      if (lifecycle.signal.aborted) return;
      const error = normalizeConnectionError(value);
      if (error.kind === 'server' && error.error.code === PUBLIC_ERROR_CODE.SESSION_REPLACED) {
        handleSessionReplaced();
        return;
      }
      connectionSync = null;
      cancelConnectionAttempt(error);
      connectionRevision += 1;
      cancelSynchronization();
      connection = 'disconnected';
      lastError = error;
      publish();
    }),
    socket.onRoomUpdate((value) => {
      if (lifecycle.signal.aborted) return;
      let update;
      try {
        update = parseCommittedRoomUpdate(value);
      } catch {
        lastError = createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE);
        publish();
        synchronizeIfConnected();
        return;
      }
      const reduction = validAuthorityView(update.view)
        ? reduceCommittedUpdate(state, update)
        : { kind: 'invalid' as const };
      if (reduction.kind === 'invalid') {
        lastError = createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE);
        publish();
        synchronizeIfConnected();
      } else if (reduction.state !== state) {
        replaceState(reduction.state);
      }
    }),
  ];

  const commandRunner = createCommandRunner({
    retryPolicy: options.retryPolicy ?? GAME_CLIENT_RETRY_POLICY,
    createActionId: options.createActionId ?? uuidV7,
    getGame: () => state.view?.game ?? null,
    emit: (command, acknowledge) => socket.emitCommand(command, acknowledge),
    synchronize,
    applySuccess: (data, command) => {
      const reduction = validAuthorityView(data.view)
        ? reduceCommandView(state, data, command)
        : { kind: 'invalid' as const };
      if (reduction.kind !== 'invalid' && reduction.state !== state) replaceState(reduction.state);
      return reduction.kind === 'invalid' ? 'invalid' : 'accepted';
    },
    applyRecovery: (incoming) => {
      const reduction = validAuthorityView(incoming)
        ? reduceRestoredView(state, incoming)
        : { kind: 'invalid' as const };
      if (reduction.kind !== 'invalid' && reduction.state !== state) replaceState(reduction.state);
      return reduction.kind === 'invalid' ? 'invalid' : 'accepted';
    },
    signal: lifecycle.signal,
  });

  function createSnapshot(): GameSessionSnapshot {
    return {
      room: state.view?.room ?? null,
      connection,
      syncStatus,
      syncRevision,
      game: state.view?.game ?? null,
      presence: state.view?.presence ?? null,
      presentation: state.presentation,
      error: lastError,
    };
  }

  const disposedCommandResult = (): Promise<CommandResult> =>
    Promise.resolve({
      ok: false,
      error: createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED),
    });
  const unavailableCommandResult = (): Promise<CommandResult> =>
    Promise.resolve({
      ok: false,
      error: createTransportError(CLIENT_ERROR_CODE.SOCKET_DISCONNECTED),
    });
  const runCommand = (command: () => Promise<CommandResult>): Promise<CommandResult> => {
    if (lifecycle.signal.aborted) return disposedCommandResult();
    if (connection !== 'connected') return unavailableCommandResult();
    return command();
  };

  const executeConnect = async (): Promise<SessionOperationResult> => {
    const attempt = { controller: new AbortController(), error: null as ClientError | null };
    connectionAttempt = attempt;
    connectionEventsEnabled = true;
    connection = 'connecting';
    publish();
    try {
      attempt.controller.signal.throwIfAborted();
      await connectUntilAborted(socket.connect(), attempt.controller.signal);
      attempt.controller.signal.throwIfAborted();
      return await acceptConnected();
    } catch (value) {
      if (attempt.error !== null) return { ok: false, error: attempt.error };
      if (lifecycle.signal.aborted) {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED) };
      }
      const error = normalizeConnectionError(value);
      if (error.kind === 'server' && error.error.code === PUBLIC_ERROR_CODE.SESSION_REPLACED) {
        handleSessionReplaced();
        return { ok: false, error };
      }
      if (connectionAttempt === attempt) {
        connectionRevision += 1;
        connectionSync = null;
        cancelSynchronization();
        connection = 'disconnected';
        lastError = error;
        publish();
      }
      return { ok: false, error };
    } finally {
      if (connectionAttempt === attempt) connectionAttempt = null;
    }
  };

  return {
    connect: async () => {
      if (lifecycle.signal.aborted) {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED) };
      }
      if (connection === 'connected') {
        return synchronize();
      }
      if (connectPromise !== null) return connectPromise;
      let beginConnection: () => void = () => {};
      const pending = new Promise<SessionOperationResult>((resolve, reject) => {
        beginConnection = () => void executeConnect().then(resolve, reject);
      }).finally(() => {
        if (connectPromise === pending) connectPromise = null;
      });
      connectPromise = pending;
      beginConnection();
      return pending;
    },
    disconnect: () => {
      if (lifecycle.signal.aborted) return;
      connectionEventsEnabled = false;
      const changed = acceptDisconnected();
      const revision = connectionRevision;
      disconnecting = true;
      try {
        socket.disconnect();
      } finally {
        disconnecting = false;
      }
      if (changed && revision === connectionRevision && !lifecycle.signal.aborted) publish();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      cancelConnectionAttempt(createProtocolError(CLIENT_ERROR_CODE.SESSION_DISPOSED));
      connectionRevision += 1;
      connectionSync = null;
      cancelSynchronization();
      lifecycle.abort();
      connection = 'disposed';
      unsubscriptions.forEach((unsubscribe) => unsubscribe());
      socket.dispose();
      subscribers.clear();
      snapshot = createSnapshot();
    },
    synchronize,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      if (lifecycle.signal.aborted) return () => {};
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    rollDice: () => runCommand(commandRunner.rollDice),
    setDieHeld: (slot, isHeld) => runCommand(() => commandRunner.setDieHeld(slot, isHeld)),
    selectScoreCategory: (categoryId) =>
      runCommand(() => commandRunner.selectScoreCategory(categoryId)),
    forfeitMatch: () => runCommand(commandRunner.forfeitMatch),
  };
}

function normalizeConnectionError(value: unknown): ClientError {
  try {
    const failure = parseSocketConnectionFailure(value);
    return createConnectionError(failure.error, failure.meta.requestId);
  } catch {
    return createTransportError(CLIENT_ERROR_CODE.SOCKET_DISCONNECTED);
  }
}

function connectUntilAborted(connection: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    void connection.catch(() => undefined);
    return Promise.reject(new Error('session disposed'));
  }
  return new Promise<void>((resolve, reject) => {
    let cleanup: () => void = () => {};
    const onAbort = (): void => {
      cleanup();
      reject(new Error('session disposed'));
    };
    cleanup = (): void => signal.removeEventListener('abort', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    connection.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}
