import { type CSSProperties } from 'react';

import { type FeedbackTiming, TURN_CUE_MS } from '@/features/game/view/feedback-timing';
import { useFeedbackTiming } from '@/features/game/view/use-feedback-timing';

export type TurnCueFeedback = Readonly<{ identity: string; timing: FeedbackTiming }>;

export function TurnStartCue({ cue, label }: Readonly<{ cue: TurnCueFeedback; label: string }>) {
  const { elapsedMs: elapsed, playState } = useFeedbackTiming(cue.timing);
  if (elapsed >= TURN_CUE_MS) return null;
  return (
    <>
      <div
        className='game-turn-cue'
        data-turn-cue='true'
        aria-hidden='true'
        style={
          {
            '--feedback-play-state': playState,
            '--turn-cue-duration': `${TURN_CUE_MS}ms`,
            animationDelay: `${-elapsed}ms`,
          } as CSSProperties
        }
      >
        <i />
        <span>YOUR TURN</span>
        <i />
      </div>
      <span className='game-turn-cue__accessible' role='status'>
        {label}
      </span>
    </>
  );
}
