import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { parseCancelRoomRequest, parseResumeRoomRequest } from '@repo/game-protocol/http';
import { createCompatibilityContract, GAME_PROTOCOL_VERSION } from '@repo/game-protocol/version';
import { describe, expect, test } from 'bun:test';

import { CLIENT_ERROR_CODE } from '../errors';
import { createServerClock } from '../server-clock';
import { createRoomHttpClient } from './http-client';

const CLIENT_ID = '01890f47-e89b-7cc3-98c5-4c5da03f78aa';
const ROOM_ID = '01890f47-e89b-7cc3-98c5-4c5da03f78ab';
const SEAT_TOKEN = '550e8400-e29b-41d4-a716-446655440000';
const REQUEST_ID = '9d6ffbb8-10a4-4d43-8c46-cd035b9e87f0';
const OPERATION_ID = 'a6f9fc18-01e4-469c-8382-301e7d85654d';
const META = {
  requestId: REQUEST_ID,
  serverTime: 1000,
  gameProtocolVersion: GAME_PROTOCOL_VERSION,
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('room HTTP client', () => {
  test('rejects unsafe timestamp metadata without accepting HTTP success or its clock sample', async () => {
    const clock = createServerClock(() => 0);
    let serverTime = Number.MAX_SAFE_INTEGER + 1;
    let requests = 0;
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      clock,
      fetch: async () => {
        requests += 1;
        return jsonResponse({
          ok: true,
          data: { cancelled: true },
          meta: { ...META, serverTime },
        });
      },
    });
    const request = parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN });

    expect(await client.cancelRoom(request)).toEqual({
      ok: false,
      error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
    });
    expect(clock.now()).toBeNull();
    expect(requests).toBe(1);

    serverTime = Number.MAX_SAFE_INTEGER;
    expect(await client.cancelRoom(request)).toMatchObject({ ok: true });
    expect(clock.now()).toBe(Number.MAX_SAFE_INTEGER);
    expect(requests).toBe(2);
  });

  test('creates a room with an exact request and returns validated authority', async () => {
    let monotonic = 0;
    const clock = createServerClock(() => monotonic);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      monotonic = 100;
      return jsonResponse(
        {
          ok: true,
          data: {
            authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN },
            view: {
              room: {
                status: 'waiting',
                roomId: ROOM_ID,
                roomCode: '123456',
                createdAt: 1,
                expiresAt: 301_000,
                seats: [
                  {
                    profile: { characterId: 'navy-bob', variant: false },
                  },
                ],
              },
              game: null,
              presence: {
                roomId: ROOM_ID,
                presenceVersion: 0,
                seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
              },
            },
          },
          meta: META,
        },
        201,
      );
    };
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      clock,
      baseUrl: 'https://game.example.test/',
      createOperationId: () => OPERATION_ID,
      fetch,
    });

    const result = await client.createRoom({
      clientId: CLIENT_ID,
      profile: { characterId: 'navy-bob', variant: false },
    });

    expect(result.ok).toBeTrue();
    expect(clock.now()).toBe(1050);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://game.example.test/rooms');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      contract: createCompatibilityContract('test-release'),
      body: {
        clientId: CLIENT_ID,
        operationId: OPERATION_ID,
        profile: { characterId: 'navy-bob', variant: false },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      data: { authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN } },
    });
  });

  test.each(['create', 'join'] as const)(
    'retries a %s action with one operation id and gives the next action a new id',
    async (operation) => {
      const bodies: string[] = [];
      let attempts = 0;
      let operationIds = 0;
      const issuedIds: string[] = [];
      const profile = { characterId: 'navy-bob', variant: false } as const;
      const playing = operation === 'join';
      const client = createRoomHttpClient({
        contract: createCompatibilityContract('test-release'),
        baseUrl: 'https://game.example.test',
        createOperationId: () => {
          operationIds += 1;
          const id = `a6f9fc18-01e4-469c-8382-${String(operationIds).padStart(12, '0')}`;
          issuedIds.push(id);
          return id;
        },
        fetch: async (_input, init) => {
          bodies.push(String(init?.body));
          attempts += 1;
          if (attempts % 2 === 1) throw new TypeError('connection reset after commit');
          return jsonResponse({
            ok: true,
            data: {
              authority: { roomId: ROOM_ID, seatIndex: playing ? 1 : 0, seatToken: SEAT_TOKEN },
              view: {
                room: {
                  roomId: ROOM_ID,
                  roomCode: '123456',
                  createdAt: 1,
                  ...(playing
                    ? { status: 'playing', startedAt: 1_000, seats: [{ profile }, { profile }] }
                    : { status: 'waiting', expiresAt: 301_000, seats: [{ profile }] }),
                },
                game: playing
                  ? {
                      stateVersion: 1,
                      match: {
                        status: 'playing',
                        players: [
                          { scorecard: {}, timeoutCount: 0 },
                          { scorecard: {}, timeoutCount: 0 },
                        ],
                        currentTurn: {
                          turnId: REQUEST_ID,
                          seatIndex: 0,
                          startedAt: 1_000,
                          deadlineAt: 61_000,
                          rollCount: 0,
                          heldSlots: [],
                          dice: null,
                        },
                      },
                    }
                  : null,
                presence: {
                  roomId: ROOM_ID,
                  presenceVersion: playing ? 1 : 0,
                  seats: playing
                    ? [{ status: 'connected' }, { status: 'connected' }]
                    : [{ status: 'disconnected', reconnectDeadlineAt: null }],
                },
              },
            },
            meta: META,
          });
        },
      });
      const invoke = () =>
        operation === 'create'
          ? client.createRoom({ clientId: CLIENT_ID, profile })
          : client.joinRoom({ clientId: CLIENT_ID, roomCode: '123456', profile });

      expect(await invoke()).toMatchObject({ ok: true });
      expect(operationIds).toBe(1);
      expect(attempts).toBe(2);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(JSON.parse(bodies[0]!)).toEqual({
        contract: createCompatibilityContract('test-release'),
        body: { clientId: CLIENT_ID, operationId: issuedIds[0], profile },
      });

      expect(await invoke()).toMatchObject({ ok: true });
      expect(operationIds).toBe(2);
      expect(attempts).toBe(4);
      expect(bodies[3]).toEqual(bodies[2]);
      expect(JSON.parse(bodies[2]!)).toEqual({
        contract: createCompatibilityContract('test-release'),
        body: { clientId: CLIENT_ID, operationId: issuedIds[1], profile },
      });
      expect(issuedIds[1]).not.toBe(issuedIds[0]);
    },
  );

  test('puts room identifiers in paths instead of duplicating them in bodies', async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      urls.push(String(input));
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse(
        {
          ok: false,
          error: { code: PUBLIC_ERROR_CODE.ROOM_NOT_FOUND, params: {} },
          meta: META,
        },
        404,
      );
    };
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      fetch,
    });

    const joined = await client.joinRoom({
      clientId: CLIENT_ID,
      roomCode: '123456',
      profile: { characterId: 'blonde-buns', variant: false },
    });
    const resumed = await client.resumeRoom(
      parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN }),
    );

    expect(urls).toEqual([
      'https://game.example.test/rooms/123456/join',
      `https://game.example.test/rooms/${ROOM_ID}/resume`,
    ]);
    expect(bodies).toEqual([
      {
        contract: createCompatibilityContract('test-release'),
        body: {
          clientId: CLIENT_ID,
          operationId: expect.any(String),
          profile: { characterId: 'blonde-buns', variant: false },
        },
      },
      { contract: createCompatibilityContract('test-release'), body: { seatToken: SEAT_TOKEN } },
    ]);
    expect(joined).toMatchObject({ ok: false, error: { kind: 'server' } });
    expect(resumed).toMatchObject({ ok: false, error: { kind: 'server' } });
  });

  test('rejects a join response for another room before updating the clock', async () => {
    const clock = createServerClock(() => 0);
    let responseRoomCode = '654321';
    let requests = 0;
    const profile = { characterId: 'navy-bob', variant: false } as const;
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      clock,
      fetch: async () => {
        requests += 1;
        return jsonResponse({
          ok: true,
          data: {
            authority: { roomId: ROOM_ID, seatIndex: 1, seatToken: SEAT_TOKEN },
            view: {
              room: {
                status: 'playing',
                roomId: ROOM_ID,
                roomCode: responseRoomCode,
                createdAt: 1,
                startedAt: 1_000,
                seats: [{ profile }, { profile }],
              },
              game: {
                stateVersion: 1,
                match: {
                  status: 'playing',
                  players: [
                    { scorecard: {}, timeoutCount: 0 },
                    { scorecard: {}, timeoutCount: 0 },
                  ],
                  currentTurn: {
                    turnId: REQUEST_ID,
                    seatIndex: 0,
                    startedAt: 1_000,
                    deadlineAt: 61_000,
                    rollCount: 0,
                    heldSlots: [],
                    dice: null,
                  },
                },
              },
              presence: {
                roomId: ROOM_ID,
                presenceVersion: 1,
                seats: [{ status: 'connected' }, { status: 'connected' }],
              },
            },
          },
          meta: META,
        });
      },
    });
    const request = { clientId: CLIENT_ID, roomCode: '123456', profile };

    const result = await client.joinRoom(request);
    expect({ result, serverTime: clock.now() }).toEqual({
      result: {
        ok: false,
        error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
      },
      serverTime: null,
    });
    expect(requests).toBe(1);

    responseRoomCode = request.roomCode;
    expect(await client.joinRoom(request)).toMatchObject({
      ok: true,
      data: { view: { room: { roomCode: request.roomCode } } },
    });
    expect(clock.now()).toBe(1_000);
  });

  test('rejects a resume response for another room before updating the clock', async () => {
    const clock = createServerClock(() => 0);
    let responseRoomId = CLIENT_ID;
    let requests = 0;
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      clock,
      fetch: async () => {
        requests += 1;
        return jsonResponse({
          ok: true,
          data: {
            seatIndex: 0,
            view: {
              room: {
                status: 'waiting',
                roomId: responseRoomId,
                roomCode: '123456',
                createdAt: 1,
                expiresAt: 301_000,
                seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
              },
              game: null,
              presence: {
                roomId: responseRoomId,
                presenceVersion: 0,
                seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
              },
            },
          },
          meta: META,
        });
      },
    });
    const request = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN });

    expect(await client.resumeRoom(request)).toEqual({
      ok: false,
      error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
    });
    expect(clock.now()).toBeNull();
    expect(requests).toBe(1);

    responseRoomId = ROOM_ID;
    expect(await client.resumeRoom(request)).toMatchObject({
      ok: true,
      data: { view: { room: { roomId: ROOM_ID } } },
    });
    expect(clock.now()).toBe(1_000);
  });

  test('normalizes invalid JSON, invalid schema, network failure, and timeout', async () => {
    const invalidJson = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      fetch: async () => new Response('{'),
    });
    const invalidSchema = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      fetch: async () => jsonResponse({ ok: true, data: { token: 'private' }, meta: META }),
    });
    const unavailable = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      fetch: async () => {
        throw new Error('private network detail');
      },
    });
    const timeout = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      timeoutMs: 1,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('private timeout')));
        }),
    });
    const request = {
      clientId: CLIENT_ID,
      profile: { characterId: 'navy-bob', variant: false },
    } as const;

    const results = await Promise.all([
      invalidJson.createRoom(request),
      invalidSchema.createRoom(request),
      unavailable.createRoom(request),
      timeout.createRoom(request),
    ]);

    expect(results.map((result) => (result.ok ? 'ok' : result.error.kind))).toEqual([
      'protocol',
      'protocol',
      'transport',
      'transport',
    ]);
    expect(results[0]).toMatchObject({ error: { code: CLIENT_ERROR_CODE.INVALID_RESPONSE } });
    expect(results[2]).toMatchObject({ error: { code: CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE } });
    expect(results[3]).toMatchObject({ error: { code: CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE } });
    expect(JSON.stringify(results)).not.toMatch(/private|token/iu);
  });

  test.each(['timeout', 'cancel', 'network'] as const)(
    'classifies body %s as transport failure, preserving retry identity',
    async (failure) => {
      const controller = new AbortController();
      const bodies: unknown[] = [];
      const client = createRoomHttpClient({
        contract: createCompatibilityContract('test-release'),
        baseUrl: 'https://game.example.test',
        timeoutMs: 5,
        fetch: async (_input, init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(
            new ReadableStream({
              start(stream) {
                if (failure === 'network') {
                  stream.error(new TypeError('private body connection reset'));
                } else {
                  init?.signal?.addEventListener(
                    'abort',
                    () => stream.error(new DOMException('private body abort', 'AbortError')),
                    { once: true },
                  );
                  if (failure === 'cancel') controller.abort();
                }
              },
            }),
          );
        },
      });

      const result = await client.createRoom(
        { clientId: CLIENT_ID, profile: { characterId: 'navy-bob', variant: false } },
        { signal: controller.signal },
      );

      expect(result).toMatchObject({
        ok: false,
        error: { kind: 'transport', code: CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE },
      });
      expect(bodies).toHaveLength(failure === 'cancel' ? 1 : 2);
      if (failure !== 'cancel') expect(bodies[1]).toEqual(bodies[0]);
      expect(JSON.stringify(result)).not.toContain('private');
    },
  );

  test.each(['cancel', 'timeout'] as const)(
    'ignores a completed response body after %s before acceptance',
    async (cancellation) => {
      const controller = new AbortController();
      const clock = createServerClock(() => 0);
      let requests = 0;
      const body = {
        ok: true,
        data: {
          authority: { roomId: ROOM_ID, seatIndex: 0, seatToken: SEAT_TOKEN },
          view: {
            room: {
              status: 'waiting',
              roomId: ROOM_ID,
              roomCode: '123456',
              createdAt: 1,
              expiresAt: 301_000,
              seats: [{ profile: { characterId: 'navy-bob', variant: false } }],
            },
            game: null,
            presence: {
              roomId: ROOM_ID,
              presenceVersion: 0,
              seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
            },
          },
        },
        meta: META,
      };
      const client = createRoomHttpClient({
        contract: createCompatibilityContract('test-release'),
        baseUrl: 'https://game.example.test',
        clock,
        timeoutMs: 5,
        fetch: async (_input, init) => {
          requests += 1;
          return new Response(
            new ReadableStream({
              pull(stream) {
                const completeBody = (): void => {
                  stream.enqueue(new TextEncoder().encode(JSON.stringify(body)));
                  stream.close();
                };
                if (cancellation === 'cancel') {
                  completeBody();
                  controller.abort();
                  return;
                }
                // A transport can still finish the body after the request deadline.
                return new Promise<void>((resolve) => {
                  init?.signal?.addEventListener(
                    'abort',
                    () => {
                      completeBody();
                      resolve();
                    },
                    { once: true },
                  );
                });
              },
            }),
          );
        },
      });

      const result = await client.createRoom(
        { clientId: CLIENT_ID, profile: { characterId: 'navy-bob', variant: false } },
        { signal: controller.signal },
      );

      expect({
        ok: result.ok,
        error: result.ok ? null : result.error,
        clock: clock.now(),
        requests,
      }).toEqual({
        ok: false,
        error: { kind: 'transport', code: CLIENT_ERROR_CODE.NETWORK_UNAVAILABLE },
        clock: null,
        requests: cancellation === 'cancel' ? 1 : 2,
      });
    },
  );

  test('preserves the original server error when resuming fails', async () => {
    const failures = [PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, PUBLIC_ERROR_CODE.RATE_LIMITED];
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      fetch: async () => {
        const code = failures.shift();
        return jsonResponse({
          ok: false,
          error:
            code === PUBLIC_ERROR_CODE.RATE_LIMITED
              ? { code, params: { retryAfterMs: 1_000 } }
              : { code, params: {} },
          meta: META,
        });
      },
    });
    const request = parseResumeRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN });

    expect(await client.resumeRoom(request)).toEqual({
      ok: false,
      error: {
        kind: 'server',
        error: { code: PUBLIC_ERROR_CODE.RESUME_NOT_AVAILABLE, params: {} },
        requestId: REQUEST_ID,
      },
    });
    expect(await client.resumeRoom(request)).toEqual({
      ok: false,
      error: {
        kind: 'server',
        error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED, params: { retryAfterMs: 1_000 } },
        requestId: REQUEST_ID,
      },
    });
  });

  test('cancels a waiting room with path authority', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse({ ok: true, data: { cancelled: true }, meta: META });
      },
    });

    const result = await client.cancelRoom(
      parseCancelRoomRequest({ roomId: ROOM_ID, seatToken: SEAT_TOKEN }),
    );

    expect(result.ok).toBeTrue();
    expect(calls).toEqual([
      {
        url: `https://game.example.test/rooms/${ROOM_ID}/cancel`,
        body: {
          contract: createCompatibilityContract('test-release'),
          body: { seatToken: SEAT_TOKEN },
        },
      },
    ]);
  });
});

test.each(['create', 'join'] as const)(
  'rejects malformed %s authority without publishing success or updating the clock',
  async (operation) => {
    const clock = createServerClock(() => 0);
    const authority = {
      roomId: ROOM_ID,
      seatToken: SEAT_TOKEN,
      seatIndex: operation === 'create' ? 0 : 1,
    };
    const profile = { characterId: 'navy-bob', variant: false } as const;
    const waiting = {
      status: 'waiting',
      roomId: ROOM_ID,
      roomCode: '123456',
      createdAt: 1,
      expiresAt: 301_000,
      seats: [{ profile }],
    };
    const playing = {
      status: 'playing',
      roomId: ROOM_ID,
      roomCode: '123456',
      createdAt: 1,
      startedAt: 1_000,
      seats: [{ profile }, { profile }],
    };
    const game = {
      stateVersion: 1,
      match: {
        status: 'playing',
        players: [
          { scorecard: {}, timeoutCount: 0 },
          { scorecard: {}, timeoutCount: 0 },
        ],
        currentTurn: {
          turnId: REQUEST_ID,
          seatIndex: 0,
          startedAt: 1_000,
          deadlineAt: 61_000,
          rollCount: 0,
          heldSlots: [],
          dice: null,
        },
      },
    };
    const presence = {
      roomId: ROOM_ID,
      presenceVersion: 1,
      seats: [{ status: 'connected' }, { status: 'connected' }],
    };
    const data = {
      view:
        operation === 'create'
          ? {
              room: waiting,
              game: null,
              presence: {
                roomId: ROOM_ID,
                presenceVersion: 0,
                seats: [{ status: 'disconnected', reconnectDeadlineAt: null }],
              },
            }
          : { room: playing, game, presence },
    };
    let responseAuthority = authority;
    let requests = 0;
    const client = createRoomHttpClient({
      contract: createCompatibilityContract('test-release'),
      baseUrl: 'https://game.example.test',
      clock,
      fetch: async () => {
        requests += 1;
        return jsonResponse({
          ok: true,
          data: { ...data, authority: responseAuthority },
          meta: META,
        });
      },
    });
    const request = () =>
      operation === 'create'
        ? client.createRoom({ clientId: CLIENT_ID, profile })
        : client.joinRoom({ clientId: CLIENT_ID, profile, roomCode: '123456' });
    for (const malformed of [
      { ...authority, roomId: CLIENT_ID },
      { ...authority, seatIndex: operation === 'create' ? 1 : 0 },
    ]) {
      responseAuthority = malformed;
      expect(await request()).toEqual({
        ok: false,
        error: { kind: 'protocol', code: CLIENT_ERROR_CODE.INVALID_RESPONSE },
      });
      expect(clock.now()).toBeNull();
    }
    expect(requests).toBe(2);
    responseAuthority = authority;
    expect(await request()).toMatchObject({ ok: true, data: { authority } });
    expect(clock.now()).toBe(1_000);
  },
);
