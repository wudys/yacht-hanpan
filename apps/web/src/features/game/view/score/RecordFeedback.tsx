import { requireGameAsset } from '@repo/game-assets';
import { UPPER_BONUS_SCORE } from '@repo/yacht-rules';
import { type ComponentProps, type CSSProperties, useId } from 'react';

import {
  type FeedbackTiming,
  RECORD_BONUS_EFFECT_END_MS,
  RECORD_BONUS_FIRST_STAR_DELAY_MS,
  RECORD_BONUS_GAIN_DELAY_MS,
  RECORD_BONUS_GAIN_DURATION_MS,
  RECORD_BONUS_GLOW_DURATION_MS,
  RECORD_BONUS_SECOND_STAR_DELAY_MS,
  RECORD_BONUS_STAR_DURATION_MS,
  RECORD_CONFIRMATION_MS,
  RECORD_FADE_OUT_MS,
  RECORD_PARTICLE_DELAY_MS,
  RECORD_PARTICLE_DURATION_MS,
  RECORD_SCORE_EFFECT_END_MS,
  RECORD_SWAP_MS,
  RECORD_SWEEP_DURATION_MS,
  RECORD_YACHT_RING_DURATION_MS,
} from '@/features/game/view/feedback-timing';
import type { ScoreRecordFeedback } from '@/features/game/view/score/types';
import { useFeedbackTiming } from '@/features/game/view/use-feedback-timing';

export function RecordTransition({
  feedback,
  style,
  ...props
}: ComponentProps<'span'> & Readonly<{ feedback?: ScoreRecordFeedback | null }>) {
  const { elapsedMs: elapsed } = useFeedbackTiming(feedback?.timing);
  const outgoing = feedback?.phase === 'outgoing';
  const phaseStart = outgoing ? RECORD_FADE_OUT_MS : RECORD_SWAP_MS;
  const phaseDuration = outgoing
    ? RECORD_SWAP_MS - RECORD_FADE_OUT_MS
    : RECORD_CONFIRMATION_MS - RECORD_SWAP_MS;
  return (
    <span
      {...props}
      data-score-transition={feedback?.phase}
      style={
        {
          ...style,
          '--record-transition-duration': `${phaseDuration}ms`,
          animationDelay: feedback ? `${phaseStart - elapsed}ms` : undefined,
        } as CSSProperties
      }
    />
  );
}

export function YachtRing({ timing }: Readonly<{ timing?: FeedbackTiming }>) {
  const gradientId = useId();
  const { elapsedMs: elapsed } = useFeedbackTiming(timing);
  const looping = timing === undefined;
  if (!looping && elapsed >= RECORD_YACHT_RING_DURATION_MS) return null;
  return (
    <svg
      className='score-feedback__ring'
      viewBox='0 0 100 100'
      preserveAspectRatio='none'
      aria-hidden='true'
      data-yacht-ring={looping ? 'available' : 'recorded'}
      style={
        {
          '--record-ring-duration': `${RECORD_YACHT_RING_DURATION_MS}ms`,
          animationDelay: `${-elapsed}ms`,
        } as CSSProperties
      }
    >
      <defs>
        <linearGradient id={gradientId}>
          <stop offset='0' stopColor='#f5aa89' />
          <stop offset='.28' stopColor='#f7dd8e' />
          <stop offset='.55' stopColor='#97dfc3' />
          <stop offset='.78' stopColor='#9dc8f8' />
          <stop offset='1' stopColor='#d3adeb' />
        </linearGradient>
      </defs>
      <rect
        x='1'
        y='1'
        width='98'
        height='98'
        rx='2'
        fill='none'
        stroke={`url(#${gradientId})`}
        strokeWidth={looping ? 1.7 : 2}
        vectorEffect='non-scaling-stroke'
        pathLength='100'
        strokeDasharray='65 35'
      />
    </svg>
  );
}

export function ScoreRecordEffect({ feedback }: Readonly<{ feedback: ScoreRecordFeedback }>) {
  const { elapsedMs: elapsed } = useFeedbackTiming(feedback.timing);
  if (elapsed >= RECORD_SCORE_EFFECT_END_MS) return null;
  const style = {
    '--record-delay': `${-elapsed}ms`,
    '--record-sweep-duration': `${RECORD_SWEEP_DURATION_MS}ms`,
    '--record-particle-duration': `${RECORD_PARTICLE_DURATION_MS}ms`,
    '--record-particle-delay': `${RECORD_PARTICLE_DELAY_MS}ms`,
  } as CSSProperties;
  return (
    <span className='score-feedback__effect' aria-hidden='true' style={style}>
      <span className='score-feedback__sweep' />
      {feedback.categoryId === 'yacht' && feedback.score > 0 ? (
        <YachtRing timing={feedback.timing} />
      ) : (
        <>
          <i className='score-feedback__particle' data-direction='left' />
          <i className='score-feedback__particle' data-direction='right' />
        </>
      )}
    </span>
  );
}

export function BonusRecordEffect({ feedback }: Readonly<{ feedback: ScoreRecordFeedback }>) {
  const { elapsedMs: elapsed } = useFeedbackTiming(feedback.timing);
  if (elapsed >= RECORD_BONUS_EFFECT_END_MS) return null;
  return (
    <span
      className='player-summary__bonus-effect'
      aria-hidden='true'
      style={
        {
          '--record-delay': `${-elapsed}ms`,
          '--record-bonus-glow-duration': `${RECORD_BONUS_GLOW_DURATION_MS}ms`,
          '--record-bonus-star-duration': `${RECORD_BONUS_STAR_DURATION_MS}ms`,
          '--record-bonus-first-star-delay': `${RECORD_BONUS_FIRST_STAR_DELAY_MS}ms`,
          '--record-bonus-second-star-delay': `${RECORD_BONUS_SECOND_STAR_DELAY_MS}ms`,
          '--record-bonus-gain-duration': `${RECORD_BONUS_GAIN_DURATION_MS}ms`,
          '--record-bonus-gain-delay': `${RECORD_BONUS_GAIN_DELAY_MS}ms`,
        } as CSSProperties
      }
    >
      <span
        className='player-summary__bonus-check-glow'
        style={{ maskImage: `url("${requireGameAsset('ui.bonus-check-active').url}")` }}
      />
      <i className='player-summary__bonus-star' data-position='first'>
        ✦
      </i>
      <i className='player-summary__bonus-star' data-position='second'>
        ✦
      </i>
      <span className='player-summary__bonus-gain'>{`+${UPPER_BONUS_SCORE}`}</span>
    </span>
  );
}
