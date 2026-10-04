import { defineConfig, devices } from '@playwright/test';
import { SERVER_READINESS_PATH } from '@repo/game-protocol/http';

import {
  PRODUCT_GAME_ORIGIN,
  PRODUCT_GAME_PORT,
  PRODUCT_SERVER_ORIGIN,
  PRODUCT_SERVER_PORT,
  PRODUCTION_GAME_ORIGIN,
  PRODUCTION_GAME_PORT,
} from './helpers/test-origins';

export default defineConfig({
  testDir: './specs',
  // Browser GPU contexts are a shared machine resource; keep each spec file serial.
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: PRODUCT_GAME_ORIGIN,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `bun --filter @repo/server build && NODE_ENV=test RENDER=true HOST=127.0.0.1 PORT=${PRODUCT_SERVER_PORT} ALLOWED_WEB_ORIGINS=${PRODUCT_GAME_ORIGIN} bun --filter @repo/server start`,
      url: `${PRODUCT_SERVER_ORIGIN}${SERVER_READINESS_PATH}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `VITE_GAME_SERVER_URL=${PRODUCT_SERVER_ORIGIN} bun --bun --filter @repo/web dev:anchors --port=${PRODUCT_GAME_PORT}`,
      url: `${PRODUCT_GAME_ORIGIN}/dev/anchors.html`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `VITE_GAME_SERVER_URL=https://game.example.test bun --filter @repo/web build && STATIC_ROOT=../../apps/web/dist PORT=${PRODUCTION_GAME_PORT} bun ./scripts/serve-static-spa.ts`,
      url: PRODUCTION_GAME_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Mute output in headed runs too, while keeping real audio playback available to tests.
        launchOptions: { args: ['--mute-audio'] },
      },
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        // Firefox reads the output volume scale as a string preference.
        launchOptions: { firefoxUserPrefs: { 'media.volume_scale': '0.0' } },
      },
    },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
