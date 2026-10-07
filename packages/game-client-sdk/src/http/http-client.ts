import {
  type CancelRoomRequest,
  type CancelRoomResponse,
  type CreateRoomRequest,
  type CreateRoomResponse,
  HTTP_METHOD,
  type JoinRoomRequest,
  type JoinRoomResponse,
  parseCancelRoomRequest,
  parseCancelRoomResponse,
  parseCreateRoomRequest,
  parseCreateRoomResponse,
  parseJoinRoomRequest,
  parseJoinRoomResponse,
  parseResumeRoomRequest,
  parseResumeRoomResponse,
  type ResumeRoomRequest,
  type ResumeRoomResponse,
  ROOM_HTTP_PATH,
} from '@repo/game-protocol/http';
import type { CompatibilityContract } from '@repo/game-protocol/version';
import { v7 as uuidV7 } from 'uuid';

import {
  CLIENT_ERROR_CODE,
  type ClientError,
  createProtocolError,
  createServerError,
  createTransportError,
} from '../errors';
import type { ServerClock } from '../server-clock';

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type SuccessData<Response> = Response extends {
  readonly ok: true;
  readonly data: infer Data;
}
  ? Data
  : never;

type SuccessMeta<Response> = Response extends { readonly ok: true; readonly meta: infer Meta }
  ? Meta
  : never;

export type ClientResult<Data, Meta = never> =
  | {
      readonly ok: true;
      readonly data: Data;
      readonly meta: Meta;
    }
  | {
      readonly ok: false;
      readonly error: ClientError;
    };

export interface RoomHttpClient {
  readonly createRoom: (
    request: CreateRoomInput,
    options?: HttpCallOptions,
  ) => Promise<ClientResult<SuccessData<CreateRoomResponse>, SuccessMeta<CreateRoomResponse>>>;
  readonly joinRoom: (
    request: JoinRoomInput,
    options?: HttpCallOptions,
  ) => Promise<ClientResult<SuccessData<JoinRoomResponse>, SuccessMeta<JoinRoomResponse>>>;
  readonly resumeRoom: (
    request: ResumeRoomRequest,
    options?: HttpCallOptions,
  ) => Promise<ClientResult<SuccessData<ResumeRoomResponse>, SuccessMeta<ResumeRoomResponse>>>;
  readonly cancelRoom: (
    request: CancelRoomRequest,
    options?: HttpCallOptions,
  ) => Promise<ClientResult<SuccessData<CancelRoomResponse>, SuccessMeta<CancelRoomResponse>>>;
}

export type CreateRoomInput = Readonly<{
  clientId: string;
  profile: CreateRoomRequest['profile'];
}>;

export type JoinRoomInput = Readonly<{
  clientId: string;
  roomCode: string;
  profile: JoinRoomRequest['profile'];
}>;

export interface HttpCallOptions {
  readonly signal?: AbortSignal;
}

export interface CreateRoomHttpClientOptions {
  readonly contract: CompatibilityContract;
  readonly clock?: ServerClock;
  readonly baseUrl: string;
  readonly fetch?: FetchLike;
  readonly createOperationId?: () => string;
  readonly timeoutMs?: number;
}

type WireResponse = CancelRoomResponse | CreateRoomResponse | JoinRoomResponse | ResumeRoomResponse;

const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const HTTP_MAX_ATTEMPTS = 2;

export function createRoomHttpClient(options: CreateRoomHttpClientOptions): RoomHttpClient {
  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis);
  const baseUrl = options.baseUrl.replace(/\/+$/u, '');
  const createOperationId = options.createOperationId ?? uuidV7;
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;

  async function request<Response extends WireResponse>(
    path: string,
    body: unknown,
    parseResponse: (value: unknown) => Response,
    callOptions?: HttpCallOptions,
  ): Promise<ClientResult<SuccessData<Response>, SuccessMeta<Response>>> {
    const envelope = { contract: options.contract, body };
    for (let attempt = 0; attempt < HTTP_MAX_ATTEMPTS; attempt += 1) {
      const result = await requestOnce(path, envelope, parseResponse, callOptions);
      if (result.ok || result.error.kind !== 'transport' || callOptions?.signal?.aborted) {
        return result;
      }
    }
    return {
      ok: false,
      error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
    };
  }

  async function requestOnce<Response extends WireResponse>(
    path: string,
    body: unknown,
    parseResponse: (value: unknown) => Response,
    callOptions?: HttpCallOptions,
  ): Promise<ClientResult<SuccessData<Response>, SuccessMeta<Response>>> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(callOptions?.signal?.reason);
    callOptions?.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (callOptions?.signal?.aborted) onExternalAbort();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const clockSample = options.clock?.beginSample();

    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: HTTP_METHOD.POST,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let raw: unknown;
      try {
        raw = await response.json();
      } catch (cause) {
        if (controller.signal.aborted || !(cause instanceof SyntaxError)) throw cause;
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE) };
      }
      controller.signal.throwIfAborted();

      let parsed: Response;
      try {
        parsed = parseResponse(raw);
      } catch {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.INVALID_RESPONSE) };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          error: createServerError(parsed.error, { requestId: parsed.meta.requestId }),
        };
      }
      if (clockSample) options.clock?.acceptSample(clockSample, parsed.meta.serverTime);
      return {
        ok: true,
        data: parsed.data as SuccessData<Response>,
        meta: parsed.meta as SuccessMeta<Response>,
      };
    } catch {
      return {
        ok: false,
        error: createTransportError(CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE),
      };
    } finally {
      clearTimeout(timeout);
      callOptions?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  return {
    createRoom: async (rawRequest, callOptions) => {
      let requestValue: CreateRoomRequest;
      try {
        requestValue = parseCreateRoomRequest({
          ...rawRequest,
          operationId: createOperationId(),
        });
      } catch {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH) };
      }
      return request(ROOM_HTTP_PATH.CREATE, requestValue, parseCreateRoomResponse, callOptions);
    },
    joinRoom: async (rawRequest, callOptions) => {
      let requestValue: JoinRoomRequest;
      try {
        requestValue = parseJoinRoomRequest({
          ...rawRequest,
          operationId: createOperationId(),
        });
      } catch {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH) };
      }
      return request(
        ROOM_HTTP_PATH.join(requestValue.roomCode),
        {
          clientId: requestValue.clientId,
          operationId: requestValue.operationId,
          profile: requestValue.profile,
        },
        (value) => {
          const response = parseJoinRoomResponse(value);
          if (response.ok && response.data.view.room.roomCode !== requestValue.roomCode) {
            throw new Error('Join response room does not match request');
          }
          return response;
        },
        callOptions,
      );
    },
    resumeRoom: async (rawRequest, callOptions) => {
      let requestValue: ResumeRoomRequest;
      try {
        requestValue = parseResumeRoomRequest(rawRequest);
      } catch {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH) };
      }
      return request(
        ROOM_HTTP_PATH.resume(requestValue.roomId),
        { seatToken: requestValue.seatToken },
        (value) => {
          const response = parseResumeRoomResponse(value);
          if (response.ok && response.data.view.room.roomId !== requestValue.roomId) {
            throw new Error('Resume response room does not match request');
          }
          return response;
        },
        callOptions,
      );
    },
    cancelRoom: async (rawRequest, callOptions) => {
      let requestValue: CancelRoomRequest;
      try {
        requestValue = parseCancelRoomRequest(rawRequest);
      } catch {
        return { ok: false, error: createProtocolError(CLIENT_ERROR_CODE.PROTOCOL_MISMATCH) };
      }
      return request(
        ROOM_HTTP_PATH.cancel(requestValue.roomId),
        { seatToken: requestValue.seatToken },
        parseCancelRoomResponse,
        callOptions,
      );
    },
  };
}
