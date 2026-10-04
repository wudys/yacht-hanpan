import release from '@repo/product-release';
import { expect, test } from 'vitest';

import { parseWebConfig, WebConfigError } from '@/bootstrap/web-config';

test('uses the canonical local server and release in development', () => {
  expect(parseWebConfig({ DEV: true })).toEqual({
    gameServerUrl: 'http://127.0.0.1:3002',
    releaseId: release.version,
  });
});

test.each(['https://yacht-game.onrender.com', 'https://3d-yacht.example.com'])(
  'accepts an exact HTTPS server origin in production: %s',
  (gameServerUrl) => {
    expect(
      parseWebConfig({
        DEV: false,
        VITE_DEPLOYMENT_ENV: 'production',
        VITE_GAME_SERVER_URL: gameServerUrl,
        VITE_SITE_ORIGIN: 'https://yacht.example.com',
      }),
    ).toEqual({
      gameServerUrl,
      releaseId: release.version,
    });
  },
);

test.each([
  {},
  { VITE_GAME_SERVER_URL: 'http://yacht-game.onrender.com' },
  { VITE_GAME_SERVER_URL: 'https://yacht-game.onrender.com/path' },
  { VITE_GAME_SERVER_URL: 'https://user:secret@example.com' },
])('rejects invalid production configuration: %o', (environment) => {
  expect(() =>
    parseWebConfig({ DEV: false, VITE_SITE_ORIGIN: 'https://yacht.example.com', ...environment }),
  ).toThrow(WebConfigError);
});

test.each([
  { VITE_GAME_SERVER_URL: 'https://localhost' },
  { VITE_GAME_SERVER_URL: 'https://127.0.0.1' },
  { VITE_GAME_SERVER_URL: 'https://game.example.test' },
  { VITE_GAME_SERVER_URL: 'https://game.localhost.' },
])('rejects local/test placeholders in an explicitly production deployment: %o', (env) => {
  expect(() =>
    parseWebConfig({
      DEV: false,
      VITE_DEPLOYMENT_ENV: 'production',
      VITE_SITE_ORIGIN: 'https://yacht.example.com',
      ...env,
    }),
  ).toThrow(WebConfigError);
});

test.each([
  undefined,
  '',
  42,
  'http://yacht.example.com',
  'https://yacht.example.com/',
  'https://yacht.example.com/path',
  'https://replace-site.invalid',
])('rejects a missing or invalid site origin in production: %s', (siteOrigin) => {
  expect(() =>
    parseWebConfig({
      DEV: false,
      VITE_DEPLOYMENT_ENV: 'production',
      VITE_GAME_SERVER_URL: 'https://game.example.com',
      VITE_SITE_ORIGIN: siteOrigin,
    }),
  ).toThrow(WebConfigError);
});
