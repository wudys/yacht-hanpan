import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { isIPv6 } from 'node:net';

import {
  parseCommittedRoomUpdate,
  ROOM_UPDATE_TYPE,
  type RoomView,
} from '@repo/game-protocol/socket';
import { createCompatibilityContract } from '@repo/game-protocol/version';

import { closeGameServerResources } from '@/app/close-game-server-resources';
import { createAuthoritativeRollCommandExecutor } from '@/roll/authoritative-roll-command-executor';
import { createProductionRollRecipeSource } from '@/roll/production-roll-recipe-source';
import type { RollCommandExecutor } from '@/roll/roll-command-executor';
import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';
import type { InMemoryRoomRepository } from '@/rooms/application/room-repository';
import type { RoomStatePublication } from '@/rooms/application/room-state-committer';
import { createRoomApplication } from '@/rooms/create-room-application';
import type { RoomId } from '@/rooms/domain/room-model';
import type { RoomApplication } from '@/rooms/room-application';
import type { Clock } from '@/runtime/clock';
import { systemClock } from '@/runtime/clock';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import { createJsonLogger, type Logger } from '@/runtime/logger';
import type { ServerConfig } from '@/runtime/server-config';
import { parseServerConfig } from '@/runtime/server-config';
import { createProductionIdentity, type ServerIdentity } from '@/runtime/server-identity';
import { ServerTelemetryMonitor, type ServerTelemetrySnapshot } from '@/runtime/server-telemetry';
import type { TaskScheduler } from '@/runtime/task-scheduler';
import { resolveClientAddress } from '@/transport/client-address';
import { HttpRequestAdmission } from '@/transport/http/http-request-admission';
import { createHttpRequestHandler } from '@/transport/http/request-handler';
import { attachGameSocketServer, type GameSocketServer } from '@/transport/socket/socket-server';

export interface StartGameServerOptions {
  readonly clock?: Clock;
  readonly config?: ServerConfig;
  readonly identity?: ServerIdentity;
  readonly logger?: Logger;
  readonly repository?: InMemoryRoomRepository;
  readonly reportUnexpected?: ErrorReporter;
  readonly resolveClientAddress?: (request: IncomingMessage) => string;
  readonly resolveSocketClientAddress?: (address: string) => string;
  readonly rolls?: RollCommandExecutor;
  readonly taskScheduler?: TaskScheduler;
}

export interface GameServer {
  readonly url: string;
  readonly close: () => Promise<void>;
  readonly isReady: () => boolean;
  readonly telemetry: { readonly snapshot: () => ServerTelemetrySnapshot };
}

export async function startGameServer(options: StartGameServerOptions = {}): Promise<GameServer> {
  const config = options.config ?? parseServerConfig(process.env);
  const clock = options.clock ?? systemClock;
  const identity = options.identity ?? createProductionIdentity();
  const logger = options.logger ?? createJsonLogger();
  const httpAdmission = new HttpRequestAdmission();
  const expectedContract = createCompatibilityContract(config.releaseId);
  let rollSimulation: RollSimulationWorkerPool | null = null;
  let rooms: RoomApplication | null = null;
  let telemetry: ServerTelemetryMonitor | null = null;
  let httpServer: HttpServer | null = null;
  let socketServer: GameSocketServer | null = null;
  let acceptingRequests = false;
  const isAcceptingRequests = () => acceptingRequests;
  const isReady = () =>
    isAcceptingRequests() && (rollSimulation === null || rollSimulation.stats().readyWorkers > 0);
  const closeResources = () =>
    closeGameServerResources({
      rooms,
      telemetry,
      socketServer,
      httpServer,
      rollSimulation,
    });
  try {
    let rolls: RollCommandExecutor;
    if (options.rolls !== undefined) {
      rolls = options.rolls;
    } else {
      rollSimulation = new RollSimulationWorkerPool({
        size: 1,
        maxQueued: 128,
        logger,
        reportUnexpected: options.reportUnexpected,
      });
      await rollSimulation.start();
      rolls = createAuthoritativeRollCommandExecutor({
        contract: expectedContract,
        logger,
        recipeSource: createProductionRollRecipeSource(),
        reportUnexpected: options.reportUnexpected,
        simulation: rollSimulation,
      });
    }
    rooms = createRoomApplication(
      {
        clock,
        expectedContract,
        identity,
        rolls,
        onSchedulerError: (error) => {
          reportUnexpected(options.reportUnexpected, error, 'scheduler.task');
          logger.error('game.scheduler.task_failed', { error });
        },
        reportUnexpected: options.reportUnexpected,
        publishRoomState: (publication) => {
          publishRoomState(socketServer, publication, logger, options.reportUnexpected);
        },
        onRoomRemoved: (roomId, view) =>
          publishRoomState(
            socketServer,
            { kind: 'removed', roomId, view },
            logger,
            options.reportUnexpected,
          ),
      },
      { repository: options.repository, taskScheduler: options.taskScheduler },
    );
    const roomApplication = rooms;
    const worker = rollSimulation;
    telemetry = new ServerTelemetryMonitor({
      logger,
      roomStats: () => roomApplication.stats(),
      transportCounts: () => ({
        httpRequests: httpAdmission.pendingCount,
        ...(socketServer?.counts() ?? { transports: 0, authenticating: 0 }),
      }),
      workerStats: worker === null ? null : () => worker.stats(),
    });
    httpServer = createServer(
      createHttpRequestHandler({
        admission: httpAdmission,
        clock,
        allowedOrigins: config.allowedOrigins,
        expectedContract,
        identity,
        isReady,
        isAcceptingRequests,
        logger,
        reportUnexpected: options.reportUnexpected,
        rooms,
        resolveClientAddress:
          options.resolveClientAddress ??
          ((request: IncomingMessage): string =>
            resolveClientAddress(
              request.headers,
              request.socket.remoteAddress,
              config.trustRenderProxy,
            )),
      }),
    );
    socketServer = attachGameSocketServer(httpServer, {
      allowedOrigins: config.allowedOrigins,
      clock,
      expectedContract,
      identity,
      isAcceptingRequests,
      logger,
      reportUnexpected: options.reportUnexpected,
      rooms,
      resolveClientAddress: (socket) =>
        options.resolveSocketClientAddress?.(socket.handshake.address || 'unknown') ??
        resolveClientAddress(
          socket.handshake.headers,
          socket.handshake.address,
          config.trustRenderProxy,
        ),
    });
    await listen(httpServer, config.host, config.port);
    rooms.startMaintenance();
    telemetry.start();
    const address = httpServer.address();
    if (address === null || typeof address === 'string')
      throw new Error('Game server did not expose a TCP address');
    const clientHost =
      config.host === '0.0.0.0' ? '127.0.0.1' : config.host === '::' ? '::1' : config.host;
    const urlHost = isIPv6(clientHost) ? `[${clientHost}]` : clientHost;
    acceptingRequests = true;
    const monitor = telemetry;
    let closePromise: Promise<void> | null = null;
    return {
      url: `http://${urlHost}:${address.port}`,
      isReady,
      telemetry: { snapshot: () => monitor.snapshot() },
      close: () => {
        if (closePromise !== null) return closePromise;
        acceptingRequests = false;
        closePromise = closeResources();
        return closePromise;
      },
    };
  } catch (error) {
    acceptingRequests = false;
    try {
      await closeResources();
    } catch (cleanupError) {
      reportUnexpected(options.reportUnexpected, cleanupError, 'shutdown');
    }
    throw error;
  }
}

function publishRoomState(
  socketServer: GameSocketServer | null,
  publication: RoomStatePublication | Readonly<{ kind: 'removed'; roomId: RoomId; view: RoomView }>,
  logger: Logger,
  reporter: ErrorReporter | undefined,
): void {
  if (socketServer === null) return;
  try {
    const { roomId } = publication;
    if (publication.kind === 'removed') {
      const { view } = publication;
      const finalUpdate =
        view.game?.match.status === 'finished'
          ? parseCommittedRoomUpdate({ type: ROOM_UPDATE_TYPE.STATE_COMMITTED, view })
          : null;
      socketServer.closeRoom(roomId, finalUpdate);
      return;
    }
    socketServer.publishRoomUpdate(roomId, publication.update);
  } catch (error) {
    reportUnexpected(reporter, error, 'room.publish');
    logger.error('room.publication.failed', { roomId: publication.roomId, error });
  }
}

async function listen(server: HttpServer, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
