import { setTimeout } from 'node:timers/promises';

const pendingStatuses = new Set([
  'created',
  'queued',
  'build_in_progress',
  'pre_deploy_in_progress',
  'update_in_progress',
]);
const failedStatuses = new Set([
  'build_failed',
  'pre_deploy_failed',
  'update_failed',
  'canceled',
  'deactivated',
]);

export function readDeploymentConfig(environment) {
  const {
    RENDER_API_KEY: apiKey,
    RENDER_SERVICE_ID: serviceId,
    GITHUB_SHA: commitId,
    VITE_GAME_SERVER_URL: serverOrigin,
  } = environment;
  if (!apiKey) throw new Error('Set the RENDER_API_KEY secret.');
  if (!/^srv-[a-zA-Z0-9]+$/u.test(serviceId ?? '')) {
    throw new Error('Set a valid RENDER_SERVICE_ID.');
  }
  if (!/^[a-f0-9]{40}$/u.test(commitId ?? '')) {
    throw new Error('GITHUB_SHA must be a full commit SHA.');
  }
  let origin;
  try {
    origin = new URL(serverOrigin);
  } catch {
    throw new Error('Set VITE_GAME_SERVER_URL to the public HTTPS server origin.');
  }
  if (origin.protocol !== 'https:' || origin.origin !== serverOrigin) {
    throw new Error('VITE_GAME_SERVER_URL must be an HTTPS origin without a path or credentials.');
  }
  return { apiKey, serviceId, commitId, serverOrigin };
}

export async function deployRender(
  config,
  { fetch: request = fetch, now = Date.now, sleep = setTimeout, timeoutMs = 1_200_000 } = {},
) {
  const deadline = now() + timeoutMs;
  const endpoint = `https://api.render.com/v1/services/${config.serviceId}/deploys`;
  const headers = {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };

  async function read(url, options) {
    if (now() >= deadline)
      throw new Error('Render deployment timed out. Check Render before retrying.');
    try {
      const response = await request(url, {
        ...options,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.min(10_000, deadline - now())),
      });
      return response;
    } catch {
      throw new Error('Deployment request failed or timed out. Check Render before retrying.');
    }
  }

  async function readDeploy(url, options) {
    const response = await read(url, { ...options, headers });
    if (response.status === 202) {
      throw new Error('Render queued the deployment without an ID. Check Render before retrying.');
    }
    if (!response.ok) throw new Error(`Render API returned HTTP ${response.status}.`);
    try {
      return await response.json();
    } catch {
      throw new Error('Render API returned invalid JSON.');
    }
  }

  const started = await readDeploy(endpoint, {
    method: 'POST',
    body: JSON.stringify({ commitId: config.commitId }),
  });
  if (!/^dep-[a-zA-Z0-9]+$/u.test(started?.id ?? '')) {
    throw new Error('Render did not return a deployment ID.');
  }
  for (;;) {
    const current = await readDeploy(`${endpoint}/${started.id}`, { method: 'GET' });
    if (current?.id !== started.id || current?.commit?.id !== config.commitId) {
      throw new Error('Render deployment ID or commit does not match the requested deployment.');
    }
    if (current.status === 'live') break;
    if (failedStatuses.has(current.status)) {
      throw new Error(`Render deployment ended with status ${current.status}.`);
    }
    if (!pendingStatuses.has(current.status))
      throw new Error('Render returned an unknown deploy status.');
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }

  for (;;) {
    const response = await read(`${config.serverOrigin}/health/ready`, { method: 'GET' });
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      if (payload?.ok === true && payload.runtime === 'bun') return started.id;
    }
    await sleep(Math.min(10_000, Math.max(0, deadline - now())));
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
      throw new Error('Usage: bun scripts/deploy-render.mjs [--check]');
    }
    const config = readDeploymentConfig(process.env);
    if (args[0] === '--check') {
      console.log('Render deployment inputs are valid.');
    } else {
      const deployId = await deployRender(config);
      console.log(`Render deployment ${deployId} is live and ready at commit ${config.commitId}.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
