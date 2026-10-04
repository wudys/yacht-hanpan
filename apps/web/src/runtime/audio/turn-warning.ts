// Keep this observer outside route mounts. The low-water mark also absorbs clock corrections.
export function createTurnWarning(play: () => void, stop: () => void) {
  let identity: string | null = null,
    lowest = Infinity,
    eligible = false;
  return {
    update(next: string | null, seconds: number | null, allowed: boolean) {
      if (next !== identity) {
        stop();
        identity = next;
        lowest = seconds ?? Infinity;
        eligible = allowed && seconds !== null && seconds > 0;
        return;
      }
      if (!allowed || !next || seconds === null || seconds <= 0) stop();
      const fresh = seconds !== null && seconds < lowest;
      if (fresh && allowed && eligible && seconds > 0 && seconds <= 5) play();
      if (seconds !== null) lowest = Math.min(lowest, seconds);
      eligible = allowed && seconds !== null && seconds > 0;
    },
  };
}
