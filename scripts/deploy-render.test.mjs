import { expect, test } from 'bun:test';

import { deployRender, readDeploymentConfig } from './deploy-render.mjs';

const config = {
  apiKey: 'test-only-api-key',
  serviceId: 'srv-example',
  commitId: 'a'.repeat(40),
  serverOrigin: 'https://example.onrender.com',
};
const deployment = (status, extra = {}) => ({
  id: 'dep-example',
  commit: { id: config.commitId },
  status,
  ...extra,
});

function fixture(responses) {
  const requests = [];
  let elapsed = 0;
  return {
    requests,
    runtime: {
      fetch: async (url, options) => {
        requests.push({ url, ...options });
        const response = responses.shift();
        if (!response) throw new Error('Unexpected request');
        return response;
      },
      now: () => elapsed,
      sleep: async (milliseconds) => {
        elapsed += milliseconds;
      },
      timeoutMs: 30_000,
    },
  };
}

test('waits for the requested Render commit to go live before checking readiness', async () => {
  const setup = fixture([
    Response.json(deployment('build_in_progress'), { status: 201 }),
    Response.json(deployment('update_in_progress')),
    Response.json(deployment('live')),
    Response.json({ ok: false, runtime: 'bun' }, { status: 503 }),
    Response.json({ ok: true, runtime: 'bun' }),
  ]);
  await expect(deployRender(config, setup.runtime)).resolves.toBe('dep-example');
  expect(setup.requests.map(({ url, method }) => [url, method])).toEqual([
    ['https://api.render.com/v1/services/srv-example/deploys', 'POST'],
    ['https://api.render.com/v1/services/srv-example/deploys/dep-example', 'GET'],
    ['https://api.render.com/v1/services/srv-example/deploys/dep-example', 'GET'],
    ['https://example.onrender.com/health/ready', 'GET'],
    ['https://example.onrender.com/health/ready', 'GET'],
  ]);
  expect(JSON.parse(setup.requests[0].body)).toEqual({ commitId: config.commitId });
  expect(setup.requests[3].headers).toBeUndefined();
});

test.each(['build_failed', 'pre_deploy_failed', 'update_failed', 'canceled', 'deactivated'])(
  'rejects %s without accepting the old server readiness',
  async (status) => {
    const setup = fixture([
      Response.json(deployment('created'), { status: 201 }),
      Response.json(deployment(status)),
      Response.json({ ok: true, runtime: 'bun' }),
    ]);
    await expect(deployRender(config, setup.runtime)).rejects.toThrow(status);
    expect(setup.requests).toHaveLength(2);
  },
);

test.each([{ commit: { id: 'b'.repeat(40) } }, { id: 'dep-another' }, { status: 'unrecognized' }])(
  'rejects a mismatched or unknown deployment: %j',
  async (extra) => {
    const setup = fixture([
      Response.json(deployment('created'), { status: 201 }),
      Response.json(deployment('live', extra)),
    ]);
    await expect(deployRender(config, setup.runtime)).rejects.toThrow();
    expect(setup.requests).toHaveLength(2);
  },
);

test('does not retrigger a queued deployment that has no trackable ID', async () => {
  const setup = fixture([new Response(null, { status: 202 })]);
  await expect(deployRender(config, setup.runtime)).rejects.toThrow('Check Render before retrying');
  expect(setup.requests).toHaveLength(1);
});

test('bounds waiting for a deployment that never goes live', async () => {
  const setup = fixture([
    Response.json(deployment('created'), { status: 201 }),
    Response.json(deployment('build_in_progress')),
    Response.json(deployment('build_in_progress')),
    Response.json(deployment('build_in_progress')),
  ]);
  await expect(deployRender(config, setup.runtime)).rejects.toThrow('timed out');
  expect(setup.requests).toHaveLength(4);
});

test('HTTP 200 with HTML or a non-ready payload never permits web deployment', async () => {
  const setup = fixture([
    Response.json(deployment('created'), { status: 201 }),
    Response.json(deployment('live')),
    new Response('<html>proxy page</html>'),
    Response.json({ ok: true, runtime: 'other' }),
    Response.json({ ok: false, runtime: 'bun' }),
  ]);
  await expect(deployRender(config, setup.runtime)).rejects.toThrow('timed out');
});

test.each([
  new Response('private response body', { status: 401 }),
  new Response('private response body', { status: 200 }),
  Response.json({ id: 'unsafe/path' }, { status: 201 }),
])('rejects invalid API responses without exposing their body', async (response) => {
  const setup = fixture([response]);
  const failure = await deployRender(config, setup.runtime).catch((error) => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).not.toContain('private response body');
  expect(failure.message).not.toContain('unsafe/path');
});

test('request errors do not expose credentials or repeat the deploy POST', async () => {
  let calls = 0;
  const failure = await deployRender(config, {
    fetch: async () => {
      calls++;
      throw new Error(config.apiKey);
    },
  }).catch((error) => error);
  expect(calls).toBe(1);
  expect(failure.message).not.toContain(config.apiKey);
  expect(failure.message).toContain('Check Render before retrying');
});

const environment = {
  RENDER_API_KEY: config.apiKey,
  RENDER_SERVICE_ID: config.serviceId,
  GITHUB_SHA: config.commitId,
  VITE_GAME_SERVER_URL: config.serverOrigin,
};

test('reads explicit deployment inputs without defaulting to the latest commit', () => {
  expect(readDeploymentConfig(environment)).toEqual(config);
});

test.each([
  { RENDER_API_KEY: '' },
  { RENDER_SERVICE_ID: 'srv-example/another' },
  { GITHUB_SHA: 'main' },
  { VITE_GAME_SERVER_URL: 'http://localhost:3002' },
  { VITE_GAME_SERVER_URL: 'https://example.onrender.com/path' },
  { VITE_GAME_SERVER_URL: 'https://user:password@example.onrender.com' },
])('rejects invalid inputs before a deployment can start: %j', (override) => {
  expect(() => readDeploymentConfig({ ...environment, ...override })).toThrow();
});
