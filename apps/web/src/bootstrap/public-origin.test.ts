import { expect, test } from 'vitest';

import { isPublicHttpsOrigin } from '@/bootstrap/public-origin';

test.each(['https://game.example.com', 'https://3d-yacht.example.com', 'https://123.example.com'])(
  'accepts a public HTTPS origin: %s',
  (origin) => {
    expect(isPublicHttpsOrigin(origin)).toBe(true);
  },
);

test.each([
  'http://game.example.com',
  'https://game.example.com/path',
  'https://user@example.com',
  'https://127.0.0.1',
  'https://2130706433',
  'https://[::1]',
  'https://localhost',
  'https://game.localhost',
  'https://game.local',
  'https://game.test',
  'https://game.invalid',
  'https://game.localhost.',
  'https://game.test.',
  'https://game.example.com.',
])('rejects non-public or non-canonical origins: %s', (origin) => {
  expect(isPublicHttpsOrigin(origin)).toBe(false);
});
