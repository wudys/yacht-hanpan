export const CAPABILITY_FAILURE_CODE = {
  FETCH_UNAVAILABLE: 'FETCH_UNAVAILABLE',
  WEBASSEMBLY_UNAVAILABLE: 'WEBASSEMBLY_UNAVAILABLE',
  WEBGL_UNAVAILABLE: 'WEBGL_UNAVAILABLE',
  WEB_AUDIO_UNAVAILABLE: 'WEB_AUDIO_UNAVAILABLE',
} as const;

export type CapabilityFailureCode =
  (typeof CAPABILITY_FAILURE_CODE)[keyof typeof CAPABILITY_FAILURE_CODE];

export type StaticCapabilityInput = Readonly<{
  fetch: boolean;
  webAssembly: boolean;
  webGl: boolean;
  webAudio: boolean;
}>;

export type StaticCapabilityResult =
  Readonly<{ ok: true }> | Readonly<{ ok: false; code: CapabilityFailureCode }>;

export function detectStaticGameplayCapabilities(
  capabilities: StaticCapabilityInput,
): StaticCapabilityResult {
  if (!capabilities.fetch) return { ok: false, code: CAPABILITY_FAILURE_CODE.FETCH_UNAVAILABLE };
  if (!capabilities.webAssembly) {
    return { ok: false, code: CAPABILITY_FAILURE_CODE.WEBASSEMBLY_UNAVAILABLE };
  }
  if (!capabilities.webGl) return { ok: false, code: CAPABILITY_FAILURE_CODE.WEBGL_UNAVAILABLE };
  if (!capabilities.webAudio) {
    return { ok: false, code: CAPABILITY_FAILURE_CODE.WEB_AUDIO_UNAVAILABLE };
  }
  return { ok: true };
}
