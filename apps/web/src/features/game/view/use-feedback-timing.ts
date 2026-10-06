import { useState } from 'react';

import { feedbackElapsed, type FeedbackTiming } from '@/features/game/view/feedback-timing';

export function useFeedbackTiming(timing?: FeedbackTiming): Readonly<{
  elapsedMs: number;
  playState: 'running' | 'paused';
}> {
  const [mountedElapsed] = useState(() =>
    timing?.mode === 'running' ? feedbackElapsed(timing, performance.now()) : 0,
  );
  return {
    elapsedMs:
      timing === undefined ? 0 : timing.mode === 'paused' ? timing.elapsedMs : mountedElapsed,
    playState: timing?.mode === 'paused' ? 'paused' : 'running',
  };
}
