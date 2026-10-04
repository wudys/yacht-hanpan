import productRelease from '@repo/product-release';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { afterEach, expect, test, vi } from 'vitest';

import { TELEMETRY_SETTINGS } from '@/runtime/telemetry/telemetry-config';

import config from '../vite.config';

const environment = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('vite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vite')>()),
  loadEnv: () => environment.values,
}));
vi.mock('@sentry/vite-plugin', () => ({
  sentryVitePlugin: vi.fn(() => ({ name: 'sentry-test' })),
}));

const originalSettings = { ...TELEMETRY_SETTINGS };
afterEach(() => {
  Object.assign(TELEMETRY_SETTINGS, originalSettings);
  environment.values = {};
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function buildConfig() {
  if (typeof config !== 'function') throw new Error('Expected a Vite config factory');
  return config({ command: 'build', mode: 'production' });
}

test('Sentry upload uses the embedded product release and keeps private sourcemaps', async () => {
  environment.values = {
    VITE_DEPLOYMENT_ENV: 'production',
    VITE_GAME_SERVER_URL: 'https://game.example.com',
    VITE_SITE_ORIGIN: 'https://yacht.example.com',
  };
  Object.assign(TELEMETRY_SETTINGS, {
    sentryDsn: 'https://publickey@o1.ingest.sentry.io/1',
    sentryProject: 'test-project',
  });
  // Never upload: the plugin is replaced at its external boundary.
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'test-upload-token');
  const result = await buildConfig();
  expect(sentryVitePlugin).toHaveBeenCalledWith(
    expect.objectContaining({
      release: {
        name: productRelease.version,
        inject: false,
        create: true,
        finalize: true,
        setCommits: false,
      },
      sourcemaps: { assets: './dist/assets/**', filesToDeleteAfterUpload: './dist/**/*.map' },
    }),
  );
  expect(result.build?.sourcemap).toBe('hidden');
  vi.stubEnv('SENTRY_AUTH_TOKEN', '');
  expect(buildConfig).toThrow(/build-only upload credentials/u);
});

test('preview does not create or upload maps', async () => {
  environment.values = { VITE_DEPLOYMENT_ENV: 'preview' };
  const result = await buildConfig();
  expect(result.build?.sourcemap).toBe(false);
  expect(sentryVitePlugin).not.toHaveBeenCalled();
});
