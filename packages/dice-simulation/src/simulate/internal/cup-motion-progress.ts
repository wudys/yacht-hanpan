export const CUP_GATHER_MS = 80;
export const CUP_EXIT_TAIL_MS = 360;

export function cupPourProgress(timeMs: number, pourAtMs: number, releaseAtMs: number): number {
  return clamp01((timeMs - pourAtMs) / Math.max(1, releaseAtMs - pourAtMs));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
