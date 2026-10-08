import { useState } from 'react';

import type { FeedbackTiming } from '@/features/game/view/feedback-timing';

export function useFeedbackTiming(timing?: FeedbackTiming): Readonly<{ elapsedMs: number }> {
  const [mountedElapsed] = useState(() =>
    timing === undefined ? 0 : Math.max(0, performance.now() - timing.startedAt),
  );
  return { elapsedMs: timing === undefined ? 0 : mountedElapsed };
}
