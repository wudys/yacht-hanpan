import { describe, expect, test } from 'vitest';

import {
  CAPABILITY_FAILURE_CODE,
  detectStaticGameplayCapabilities,
} from '@/bootstrap/static-capabilities';

describe('detectStaticGameplayCapabilities', () => {
  test('accepts the required static browser capabilities', () => {
    expect(
      detectStaticGameplayCapabilities({
        fetch: true,
        webAssembly: true,
        webGl: true,
        webAudio: true,
      }),
    ).toEqual({ ok: true });
  });

  test.each([
    ['fetch', CAPABILITY_FAILURE_CODE.FETCH_UNAVAILABLE],
    ['webAssembly', CAPABILITY_FAILURE_CODE.WEBASSEMBLY_UNAVAILABLE],
    ['webGl', CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE],
    ['webAudio', CAPABILITY_FAILURE_CODE.WEB_AUDIO_UNAVAILABLE],
  ] as const)('returns a stable code when %s is unavailable', (key, code) => {
    const capabilities = {
      fetch: true,
      webAssembly: true,
      webGl: true,
      webAudio: true,
    };
    expect(detectStaticGameplayCapabilities({ ...capabilities, [key]: false })).toEqual({
      ok: false,
      code,
    });
  });
});
