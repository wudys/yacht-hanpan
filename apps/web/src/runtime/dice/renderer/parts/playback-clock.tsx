import { createContext, type ReactNode, use, useState } from 'react';

interface RollPlaybackClock {
  elapsedMs: () => number;
  start: () => void;
}

const RollPlaybackClockContext = createContext<RollPlaybackClock | null>(null);

function createRollPlaybackClock(): RollPlaybackClock {
  let startedAt: number | null = null;
  return {
    elapsedMs: () => (startedAt === null ? 0 : Math.max(0, performance.now() - startedAt)),
    start: () => {
      if (startedAt === null) startedAt = performance.now();
    },
  };
}

export function RollPlaybackClockProvider({ children }: { children: ReactNode }) {
  const [clock] = useState(createRollPlaybackClock);
  return (
    <RollPlaybackClockContext.Provider value={clock}>{children}</RollPlaybackClockContext.Provider>
  );
}

// The hook intentionally shares the provider module so both use one context.
// eslint-disable-next-line react-refresh/only-export-components
export function useRollPlaybackClock(): RollPlaybackClock {
  const value = use(RollPlaybackClockContext);
  if (!value) throw new Error('useRollPlaybackClock must be used within RollPlaybackClockProvider');
  return value;
}
