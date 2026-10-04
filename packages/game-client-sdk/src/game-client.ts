import { createCompatibilityContract } from '@repo/game-protocol/version';

import {
  createRoomHttpClient,
  type CreateRoomHttpClientOptions,
  type RoomHttpClient,
} from './http/http-client';
import type { GameSocketFactory, RoomAuthority } from './ports';
import { createServerClock, type ServerClock } from './server-clock';
import type { RetryPolicy } from './session/retry-policy';
import { createGameSession, type GameSession } from './session/session';

export interface CreateGameClientOptions {
  readonly serverUrl: string;
  readonly releaseId: string;
  readonly fetch?: CreateRoomHttpClientOptions['fetch'];
  readonly socketFactory?: GameSocketFactory;
  readonly httpTimeoutMs?: number;
  readonly retryPolicy?: RetryPolicy;
  readonly createActionId?: () => string;
  readonly createOperationId?: () => string;
}

export interface GameClient extends RoomHttpClient {
  readonly clock: ServerClock;
  readonly createSession: (authority: RoomAuthority) => GameSession;
}

export function createGameClient(options: CreateGameClientOptions): GameClient {
  const clock = createServerClock();
  const contract = createCompatibilityContract(options.releaseId);
  const http = createRoomHttpClient({
    clock,
    contract,
    baseUrl: options.serverUrl,
    createOperationId: options.createOperationId,
    fetch: options.fetch,
    timeoutMs: options.httpTimeoutMs,
  });

  return {
    clock,
    cancelRoom: http.cancelRoom,
    createRoom: http.createRoom,
    joinRoom: http.joinRoom,
    resumeRoom: http.resumeRoom,
    createSession: (authority) =>
      createGameSession({
        clock,
        socketUrl: options.serverUrl,
        authority,
        contract,
        socketFactory: options.socketFactory,
        retryPolicy: options.retryPolicy,
        createActionId: options.createActionId,
      }),
  };
}
