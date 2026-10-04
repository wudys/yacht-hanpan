import productRelease from '@repo/product-release';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { configureAnalyticsHtml } from './build/analytics-html.ts'; // eslint-disable-line import-x/extensions -- Native Vite config requires extensions.
import { createSiteMetadata } from './build/site-metadata.ts'; // eslint-disable-line import-x/extensions -- Native Vite config requires extensions.
import { readPublicSiteOrigin } from './src/bootstrap/public-origin.ts'; // eslint-disable-line import-x/extensions -- Native Vite config requires extensions.
import {
  readTelemetryConfig,
  TELEMETRY_SETTINGS,
} from './src/runtime/telemetry/telemetry-config.ts'; // eslint-disable-line import-x/extensions -- Native Vite config requires extensions.
import { parseWebConfig } from './src/bootstrap/web-config.ts'; // eslint-disable-line import-x/extensions -- Native Vite config requires extensions.
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (env.VITE_SENTRY_AUTH_TOKEN)
    throw new Error('SENTRY_AUTH_TOKEN must never use the public VITE_ prefix.');
  if (command === 'build' && env.VITE_DEPLOYMENT_ENV === 'production') {
    if (mode !== 'production')
      throw new Error('Production deployment requires Vite production mode.');
    parseWebConfig({ ...env, DEV: false });
  }
  const siteOrigin = readPublicSiteOrigin(env);
  const telemetry = readTelemetryConfig(
    { ...env, PROD: command === 'build', MODE: mode },
    siteOrigin,
  );
  const uploadMaps = command === 'build' && telemetry.enabled && telemetry.sentryDsn !== null;
  if (
    uploadMaps &&
    (!process.env.SENTRY_AUTH_TOKEN ||
      !TELEMETRY_SETTINGS.sentryOrg ||
      !TELEMETRY_SETTINGS.sentryProject)
  ) {
    throw new Error('Production Sentry requires build-only upload credentials and project.');
  }
  return {
    plugins: [
      react(),
      {
        name: 'hanpan-site-metadata',
        transformIndexHtml: () => createSiteMetadata(siteOrigin),
      },
      {
        name: 'hanpan-analytics-html',
        transformIndexHtml: {
          order: 'pre',
          handler: (html) => configureAnalyticsHtml(html, telemetry),
        },
      },
      ...(uploadMaps
        ? [
            sentryVitePlugin({
              authToken: process.env.SENTRY_AUTH_TOKEN,
              org: TELEMETRY_SETTINGS.sentryOrg,
              project: TELEMETRY_SETTINGS.sentryProject,
              telemetry: false,
              release: {
                name: productRelease.version,
                inject: false,
                create: true,
                finalize: true,
                setCommits: false,
              },
              sourcemaps: {
                assets: './dist/assets/**',
                filesToDeleteAfterUpload: './dist/**/*.map',
              },
            }),
          ]
        : []),
    ],
    build: { sourcemap: uploadMaps ? 'hidden' : false },
    publicDir: fileURLToPath(new URL('../../packages/game-assets/public', import.meta.url)),
    resolve: {
      alias: [
        { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        {
          find: './rapier_wasm3d',
          replacement: fileURLToPath(
            new URL(
              '../../packages/dice-simulation/node_modules/@dimforge/rapier3d-deterministic/rapier_wasm3d_bg.js',
              import.meta.url,
            ),
          ),
        },
      ],
      dedupe: ['react', 'react-dom'],
    },
    optimizeDeps: {
      exclude: ['@dimforge/rapier3d-deterministic'],
    },
    server: { port: 3001, strictPort: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  };
});
