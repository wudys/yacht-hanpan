import { useState } from 'react';

import type { FeedbackTiming } from '@/features/game/ui/feedback-timing';

export function useFeedbackElapsedAtMount(
  timing?: FeedbackTiming,
): Readonly<{ elapsedMs: number }> {
  const [mountedElapsed] = useState(() =>
    timing === undefined ? 0 : Math.max(0, performance.now() - timing.startedAt),
  );
  return { elapsedMs: timing === undefined ? 0 : mountedElapsed };
}
