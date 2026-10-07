import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  createPublicError,
  type ProtocolResult,
  PUBLIC_ERROR_CODE,
} from '@repo/game-protocol/errors';
import {
  HTTP_METHOD,
  matchRoomHttpPath,
  parseCancelRoomBody,
  parseCancelRoomRequest,
  parseCancelRoomResponse,
  parseCreateRoomRequest,
  parseCreateRoomResponse,
  parseJoinRoomBody,
  parseJoinRoomRequest,
  parseJoinRoomResponse,
  parseResumeRoomBody,
  parseResumeRoomRequest,
  parseResumeRoomResponse,
  parseRoomHttpEnvelope,
  ROOM_HTTP_ROUTE_KIND,
  SERVER_READINESS_PATH,
  type ServerReadinessPayload,
} from '@repo/game-protocol/http';
import {
  assertExactCompatibility,
  type CompatibilityContract,
  GAME_PROTOCOL_VERSION,
} from '@repo/game-protocol/version';

import type { RoomApplication } from '@/rooms/room-application';
import { type Clock, systemClock } from '@/runtime/clock';
import { type ErrorReporter, reportUnexpected } from '@/runtime/error-reporter';
import type { Logger } from '@/runtime/logger';
import type { ServerIdentity } from '@/runtime/server-identity';
import { HttpRequestAdmission } from '@/transport/http/http-request-admission';
import { httpStatusForPublicError } from '@/transport/http/public-error-status';
import { readJsonBody } from '@/transport/http/read-json-body';
import { isBrowserOriginAllowed } from '@/transport/origin-policy';

const SERVER_HTTP_PATH = {
  HEALTH: '/health',
  HEALTH_LIVE: '/health/live',
} as const;

type PublicResponseParser = (value: unknown) => unknown;

export interface HttpRequestHandlerDependencies {
  readonly admission?: HttpRequestAdmission;
  readonly requestBodyTimeoutMs?: number;
  readonly expectedContract: CompatibilityContract;
  readonly clock?: Clock;
  readonly allowedOrigins: readonly string[];
  readonly identity: Pick<ServerIdentity, 'createRequestId'>;
  readonly isAcceptingRequests: () => boolean;
  readonly isReady: () => boolean;
  readonly logger: Logger;
  readonly reportUnexpected?: ErrorReporter;
  readonly resolveClientAddress: (request: IncomingMessage) => string;
  readonly rooms: Pick<RoomApplication, 'cancelRoom' | 'createRoom' | 'joinRoom' | 'resumeRoom'>;
}

export function createHttpRequestHandler(
  dependencies: HttpRequestHandlerDependencies,
): (request: IncomingMessage, response: ServerResponse) => void {
  const admission = dependencies.admission ?? new HttpRequestAdmission();
  return (request: IncomingMessage, response: ServerResponse): void => {
    const isRoomRequest =
      request.method === HTTP_METHOD.POST && matchRoomHttpPath(safePathname(request.url)) !== null;
    const admitted = !isRoomRequest || admission.acquire();
    void handleRequest(request, response, dependencies, !admitted).finally(() => {
      if (isRoomRequest && admitted) admission.release();
    });
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: HttpRequestHandlerDependencies,
  overloaded: boolean,
): Promise<void> {
  const startedAt: number = performance.now();
  const requestId: string = dependencies.identity.createRequestId();
  let status = 500;
  let publicCode: string | undefined;
  try {
    const origin = headerValue(request.headers.origin);
    if (!isBrowserOriginAllowed(origin, dependencies.allowedOrigins)) {
      writeJson(response, 403, { ok: false });
      status = 403;
      return;
    }
    if (origin !== undefined) applyCorsResponseHeaders(response, origin);
    if (overloaded) {
      const error = createPublicError(PUBLIC_ERROR_CODE.RATE_LIMITED, { retryAfterMs: 1_000 });
      response.setHeader('connection', 'close');
      response.once('finish', () => request.destroy());
      status = sendPublicResponse(
        response,
        { ok: false, error },
        requestId,
        parseCreateRoomResponse,
        200,
        dependencies.clock,
      );
      publicCode = error.code;
      return;
    }

    const result = await routeRequest(request, response, requestId, dependencies);
    status = result.status;
    publicCode = result.publicCode;
  } catch (error) {
    reportUnexpected(dependencies.reportUnexpected, error, 'http.request');
    dependencies.logger.error('http.request.failed', {
      requestId,
      error: error instanceof Error ? error : null,
    });
    const failure = createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {});
    status = sendPublicResponse(
      response,
      { ok: false, error: failure },
      requestId,
      parseCreateRoomResponse,
      200,
      dependencies.clock,
    );
    publicCode = failure.code;
  } finally {
    const level = status >= 400 ? 'warn' : 'debug';
    dependencies.logger[level]('http.request.completed', {
      requestId,
      method: request.method ?? null,
      path: safePathname(request.url),
      status,
      publicCode: publicCode ?? null,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
    });
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestId: string,
  dependencies: HttpRequestHandlerDependencies,
): Promise<{ readonly status: number; readonly publicCode?: string }> {
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://localhost');
  } catch {
    return sendRouteFailure(response, requestId, 400);
  }
  if (url.search.length > 0) {
    return sendRouteFailure(response, requestId, 404);
  }

  const roomRoute = matchRoomHttpPath(url.pathname);
  if (request.method === HTTP_METHOD.OPTIONS && roomRoute !== null) {
    response.writeHead(204, {
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    });
    response.end();
    return { status: 204 };
  }

  if (
    request.method === HTTP_METHOD.GET &&
    (url.pathname === SERVER_HTTP_PATH.HEALTH || url.pathname === SERVER_HTTP_PATH.HEALTH_LIVE)
  ) {
    writeJson(response, 200, { ok: true, runtime: 'bun' });
    return { status: 200 };
  }
  if (request.method === HTTP_METHOD.GET && url.pathname === SERVER_READINESS_PATH) {
    const ready: boolean = dependencies.isReady();
    const status = ready ? 200 : 503;
    writeJson(response, status, { ok: ready, runtime: 'bun' } satisfies ServerReadinessPayload);
    return { status };
  }

  const isPublicPost = request.method === HTTP_METHOD.POST && roomRoute !== null;
  if (!isPublicPost) return sendRouteFailure(response, requestId, 404);

  const receivedBody = await readJsonBody(request, dependencies.requestBodyTimeoutMs);
  if (!receivedBody.ok) {
    if (receivedBody.closeConnection) {
      response.setHeader('connection', 'close');
      response.once('finish', () => request.destroy());
    }
    return sendRouteFailure(response, requestId, receivedBody.status);
  }
  let body: unknown = receivedBody.value;

  try {
    assertExactCompatibility(
      typeof body === 'object' && body !== null && 'contract' in body ? body.contract : undefined,
      dependencies.expectedContract,
    );
  } catch {
    const error = createPublicError(PUBLIC_ERROR_CODE.PROTOCOL_MISMATCH, {});
    const status = sendPublicResponse(
      response,
      { ok: false, error },
      requestId,
      parseCreateRoomResponse,
      200,
      dependencies.clock,
    );
    return { status, publicCode: error.code };
  }
  try {
    body = parseRoomHttpEnvelope(body).body;
  } catch {
    return sendRouteFailure(response, requestId, 400);
  }

  if (!dependencies.isAcceptingRequests()) {
    const error = createPublicError(PUBLIC_ERROR_CODE.INTERNAL_ERROR, {});
    const status = sendPublicResponse(
      response,
      { ok: false, error },
      requestId,
      parseCreateRoomResponse,
      200,
      dependencies.clock,
    );
    return { status, publicCode: error.code };
  }

  if (roomRoute.kind === ROOM_HTTP_ROUTE_KIND.CREATE) {
    let parsed;
    try {
      parsed = parseCreateRoomRequest(body);
    } catch {
      return sendRouteFailure(response, requestId, 400);
    }
    const applicationResult = await dependencies.rooms.createRoom(
      parsed,
      dependencies.resolveClientAddress(request),
    );
    const status = sendPublicResponse(
      response,
      applicationResult,
      requestId,
      parseCreateRoomResponse,
      201,
      dependencies.clock,
    );
    return {
      status,
      publicCode: applicationResult.ok ? undefined : applicationResult.error.code,
    };
  }

  if (roomRoute.kind === ROOM_HTTP_ROUTE_KIND.RESUME) {
    let parsed;
    try {
      parsed = parseResumeRoomRequest({ ...parseResumeRoomBody(body), roomId: roomRoute.roomId });
    } catch {
      return sendRouteFailure(response, requestId, 400);
    }
    const applicationResult = await dependencies.rooms.resumeRoom(parsed);
    const status = sendPublicResponse(
      response,
      applicationResult,
      requestId,
      parseResumeRoomResponse,
      200,
      dependencies.clock,
    );
    return {
      status,
      publicCode: applicationResult.ok ? undefined : applicationResult.error.code,
    };
  }

  if (roomRoute.kind === ROOM_HTTP_ROUTE_KIND.CANCEL) {
    let parsed;
    try {
      parsed = parseCancelRoomRequest({ ...parseCancelRoomBody(body), roomId: roomRoute.roomId });
    } catch {
      return sendRouteFailure(response, requestId, 400);
    }
    const applicationResult = await dependencies.rooms.cancelRoom(parsed);
    const status = sendPublicResponse(
      response,
      applicationResult,
      requestId,
      parseCancelRoomResponse,
      200,
      dependencies.clock,
    );
    return {
      status,
      publicCode: applicationResult.ok ? undefined : applicationResult.error.code,
    };
  }

  let parsed;
  try {
    parsed = parseJoinRoomRequest({ ...parseJoinRoomBody(body), roomCode: roomRoute.roomCode });
  } catch {
    return sendRouteFailure(response, requestId, 400);
  }
  const applicationResult = await dependencies.rooms.joinRoom(parsed);
  const status = sendPublicResponse(
    response,
    applicationResult,
    requestId,
    parseJoinRoomResponse,
    200,
    dependencies.clock,
  );
  return { status, publicCode: applicationResult.ok ? undefined : applicationResult.error.code };
}

function sendRouteFailure(
  response: ServerResponse,
  requestId: string,
  status: number,
): { readonly status: number; readonly publicCode: string } {
  const error = createPublicError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {});
  const envelope = parseCreateRoomResponse({
    ok: false,
    error,
    meta: { requestId, gameProtocolVersion: GAME_PROTOCOL_VERSION },
  });
  writeJson(response, status, envelope);
  return { status, publicCode: error.code };
}

function sendPublicResponse(
  response: ServerResponse,
  result: ProtocolResult<unknown>,
  requestId: string,
  parser: PublicResponseParser,
  successStatus: number,
  clock: Clock = systemClock,
): number {
  const envelope = parser({
    ...result,
    meta: {
      requestId,
      gameProtocolVersion: GAME_PROTOCOL_VERSION,
      ...(result.ok ? { serverTime: clock.now() } : {}),
    },
  });
  const status = result.ok ? successStatus : httpStatusForPublicError(result.error.code);
  writeJson(response, status, envelope);
  return status;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function applyCorsResponseHeaders(response: ServerResponse, origin: string): void {
  response.setHeader('access-control-allow-origin', origin);
  response.setHeader('vary', 'Origin');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safePathname(rawUrl: string | undefined): string {
  try {
    return new URL(rawUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}
