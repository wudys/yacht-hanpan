import release from '@repo/product-release';
import { describe, expect, test } from 'bun:test';

import { parseServerConfig, ServerConfigError } from '@/runtime/server-config';

describe('server config', () => {
  test('uses safe development defaults', () => {
    expect(parseServerConfig({})).toEqual({
      allowedOrigins: [
        'http://localhost:3001',
        'http://127.0.0.1:3001',
        'http://localhost:4173',
        'http://127.0.0.1:4173',
      ],
      trustRenderProxy: false,
      host: '127.0.0.1',
      port: 3002,
      releaseId: release.version,
    });
  });

  test('parses explicit production config', () => {
    expect(
      parseServerConfig({
        NODE_ENV: 'production',
        HOST: '0.0.0.0',
        PORT: '8080',
        ALLOWED_WEB_ORIGINS: 'https://yacht.example,https://preview.yacht.example',
      }),
    ).toEqual({
      allowedOrigins: ['https://yacht.example', 'https://preview.yacht.example'],
      trustRenderProxy: false,
      host: '0.0.0.0',
      port: 8080,
      releaseId: release.version,
    });
  });

  test('trusts the Render edge only when the platform marks this runtime', () => {
    expect(parseServerConfig({ RENDER: 'true', PORT: '10000' })).toMatchObject({
      trustRenderProxy: true,
      host: '0.0.0.0',
      port: 10000,
    });
    expect(parseServerConfig({ RENDER: 'false' })).toMatchObject({
      trustRenderProxy: false,
      host: '127.0.0.1',
    });
  });

  test.each([
    { NODE_ENV: 'production' },
    {
      NODE_ENV: 'production',
      ALLOWED_WEB_ORIGINS: 'https://yacht.example/path',
    },
    {
      NODE_ENV: 'production',
      ALLOWED_WEB_ORIGINS: '*',
    },
    { NODE_ENV: 'unknown' },
    { PORT: '-1' },
    { PORT: '65536' },
    { PORT: 'not-a-number' },
    { HOST: '' },
  ])('rejects unsafe or malformed config', (environment) => {
    expect(() => parseServerConfig(environment)).toThrow(ServerConfigError);
  });
});
