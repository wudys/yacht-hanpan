import { createServer, request as createRequest } from 'node:http';

import { PUBLIC_ERROR_CODE } from '@repo/game-protocol/errors';
import { createCompatibilityContract } from '@repo/game-protocol/version';
import { expect, test } from 'bun:test';

import type { ErrorReporter } from '@/runtime/error-reporter';
import { createProductionIdentity } from '@/runtime/server-identity';
import { HttpRequestAdmission } from '@/transport/http/http-request-admission';
import {
  createHttpRequestHandler,
  type HttpRequestHandlerDependencies,
} from '@/transport/http/request-handler';

async function fixture(
  createRoom: HttpRequestHandlerDependencies['rooms']['createRoom'],
  requestBodyTimeoutMs: number = 5_000,
  onReport?: ErrorReporter,
) {
  const admission = new HttpRequestAdmission(2);
  const reports: Array<Parameters<ErrorReporter>> = [];
  const failure = {
    ok: false,
    error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} },
  } as const;
  const server = createServer(
    createHttpRequestHandler({
      admission,
      requestBodyTimeoutMs,
      allowedOrigins: [],
      expectedContract: createCompatibilityContract('test-release'),
      identity: createProductionIdentity(),
      isReady: () => true,
      isAcceptingRequests: () => true,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
      reportUnexpected: (error, operation) => {
        reports.push([error, operation]);
        onReport?.(error, operation);
      },
      resolveClientAddress: () => 'test-address',
      rooms: {
        createRoom,
        joinRoom: async () => failure,
        cancelRoom: async () => failure,
        resumeRoom: async () => failure,
      },
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  return {
    url: `http://127.0.0.1:${address.port}`,
    admission,
    reports,
    close: async () => {
      server.closeAllConnections();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function post(url: string): Promise<Response> {
  return fetch(`${url}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contract: createCompatibilityContract('test-release'),
      body: {
        clientId: '018f47f2-c2d8-7f4a-8bf4-3f559c39843d',
        operationId: crypto.randomUUID(),
        profile: { characterId: 'navy-bob', variant: false },
      },
    }),
  });
}

test('bounds pending HTTP responses while health stays reachable and reclaims completed slots', async () => {
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const server = await fixture(async () => {
    calls += 1;
    if (calls === 2) entered.resolve();
    await gate.promise;
    return { ok: false, error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} } };
  });
  const pending = [post(server.url), post(server.url)];
  try {
    await entered.promise;
    const rejected = await post(server.url);
    expect(rejected.status).toBe(429);
    expect(await rejected.json()).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.RATE_LIMITED },
    });
    expect((await fetch(`${server.url}/health/ready`)).status).toBe(200);
    expect(server.admission.pendingCount).toBe(2);
    expect(server.reports).toEqual([]);
    gate.resolve();
    await Promise.all(pending);
    expect(server.admission.pendingCount).toBe(0);
    const reclaimed = await post(server.url);
    expect(reclaimed.status).toBe(403);
    expect(await reclaimed.json()).toMatchObject({
      error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY },
    });
  } finally {
    gate.resolve();
    await Promise.all(pending);
    await server.close();
  }
});

test.each([false, true])(
  'reclaims HTTP admission after malformed input and application failure even if reporter throws: %s',
  async (reporterThrows) => {
    const cause = new RangeError('private cause');
    const error = new TypeError('private infrastructure failure', { cause });
    const server = await fixture(
      async () => {
        throw error;
      },
      5_000,
      () => {
        if (reporterThrows) throw new Error('diagnostic failure');
      },
    );
    try {
      const malformed = await fetch(`${server.url}/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      expect(malformed.status).toBe(400);
      expect(server.admission.pendingCount).toBe(0);
      expect(server.reports).toEqual([]);
      const response = await post(server.url);
      expect(response.status).toBe(500);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({
        ok: false,
        error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
      });
      expect(body).not.toMatch(/private|cause|stack|message/u);
      expect(server.reports).toEqual([[error, 'http.request']]);
      expect(server.reports[0]?.[0]).toBe(error);
      expect(server.admission.pendingCount).toBe(0);
    } finally {
      await server.close();
    }
  },
);

test('expires an incomplete HTTP body and releases admission without application effects', async () => {
  let effects = 0;
  const server = await fixture(async () => {
    effects += 1;
    throw new Error('unexpected application');
  }, 20);
  const request = createRequest(`${server.url}/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': '1000' },
  });
  const response = new Promise<number | undefined>((resolve, reject) => {
    request.once('response', (received) => {
      received.resume();
      received.once('end', () => resolve(received.statusCode));
    });
    request.once('error', reject);
  });
  try {
    request.write('{');
    expect(await response).toBe(408);
    expect(effects).toBe(0);
    expect(server.admission.pendingCount).toBe(0);
    expect(server.reports).toEqual([]);
  } finally {
    request.destroy();
    await server.close();
  }
});

test('typed application refusal does not synthesize an internal error issue', async () => {
  const server = await fixture(async () => ({
    ok: false,
    error: { code: PUBLIC_ERROR_CODE.INTERNAL_ERROR, params: {} },
  }));
  try {
    expect((await post(server.url)).status).toBe(500);
    expect(server.reports).toEqual([]);
    expect(server.admission.pendingCount).toBe(0);
  } finally {
    await server.close();
  }
});

test('rejects a malformed raw request-target without an infrastructure report', async () => {
  let effects = 0;
  const server = await fixture(async () => {
    effects += 1;
    return { ok: false, error: { code: PUBLIC_ERROR_CODE.INVALID_AUTHORITY, params: {} } };
  });
  try {
    const received = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const request = createRequest(server.url, { method: 'GET', path: '//%' }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.once('end', () => resolve({ status: response.statusCode, body }));
        });
        request.once('error', reject);
        request.end();
      },
    );
    expect(received.status).toBe(400);
    expect(JSON.parse(received.body)).toMatchObject({
      ok: false,
      error: { code: PUBLIC_ERROR_CODE.INVALID_REQUEST, params: {} },
    });
    expect(effects).toBe(0);
    expect(server.reports).toEqual([]);
    expect(server.admission.pendingCount).toBe(0);
  } finally {
    await server.close();
  }
});
