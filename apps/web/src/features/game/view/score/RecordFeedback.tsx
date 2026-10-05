import { requireGameAsset } from '@repo/game-assets';
import { type ComponentProps, type CSSProperties, useId, useState } from 'react';

import type { ScoreRecordFeedback } from '@/features/game/view/score/types';

export function RecordTransition({
  feedback,
  style,
  ...props
}: ComponentProps<'span'> & Readonly<{ feedback?: ScoreRecordFeedback | null }>) {
  const [elapsed] = useState(() =>
    feedback ? Math.max(0, performance.now() - feedback.startedAt) : 0,
  );
  const phaseStart = feedback?.phase === 'outgoing' ? 800 : 900;
  return (
    <span
      {...props}
      data-score-transition={feedback?.phase}
      style={{ ...style, animationDelay: feedback ? `${phaseStart - elapsed}ms` : undefined }}
    />
  );
}

export function YachtRing({ startedAt }: Readonly<{ startedAt?: number }>) {
  const gradientId = useId();
  const [elapsed] = useState(() =>
    startedAt === undefined ? 0 : Math.max(0, performance.now() - startedAt),
  );
  const looping = startedAt === undefined;
  if (!looping && elapsed >= 650) return null;
  return (
    <svg
      className='score-feedback__ring'
      viewBox='0 0 100 100'
      preserveAspectRatio='none'
      aria-hidden='true'
      data-yacht-ring={looping ? 'available' : 'recorded'}
      style={{ animationDelay: `${-elapsed}ms` }}
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
  const [elapsed] = useState(() => Math.max(0, performance.now() - feedback.startedAt));
  if (elapsed >= 670) return null;
  const style = { '--record-delay': `${-elapsed}ms` } as CSSProperties;
  return (
    <span className='score-feedback__effect' aria-hidden='true' style={style}>
      <span className='score-feedback__sweep' />
      {feedback.categoryId === 'yacht' && feedback.score > 0 ? (
        <YachtRing startedAt={feedback.startedAt} />
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
  const [elapsed] = useState(() => Math.max(0, performance.now() - feedback.startedAt));
  if (elapsed >= 800) return null;
  return (
    <span
      className='player-summary__bonus-effect'
      aria-hidden='true'
      style={{ '--record-delay': `${-elapsed}ms` } as CSSProperties}
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
      <span className='player-summary__bonus-gain'>+35</span>
    </span>
  );
}
