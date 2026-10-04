import type { CSSProperties } from 'react';

import {
  ACHIEVEMENT_SEQUENCE_DURATION_MS,
  type AchievementKind,
} from '@/ui/presentation/achievement-sequence-contract';

export type AchievementSequenceProps = Readonly<{
  title: string;
  kind: AchievementKind;
}>;

const PARTICLES = [
  [12, 42, -18, -14, 9, -8, 140, 'spark'],
  [25, 31, -12, -21, 7, 18, 180, 'spark'],
  [45, 27, -2, -24, 8, -16, 220, 'spark'],
  [84, 38, 18, -15, 10, -18, 260, 'spark'],
  [35, 54, -7, 4, 4, 16, 300, 'diamond'],
  [63, 62, 8, 16, 7, 14, 340, 'diamond'],
  [38, 40, -5, -12, 5, 25, 380, 'spark'],
  [76, 55, 14, 12, 6, 30, 420, 'diamond'],
  [18, 58, -15, 13, 6, 45, 500, 'diamond'],
  [69, 29, 12, -22, 8, -12, 540, 'spark'],
  [22, 48, -14, -2, 5, -24, 580, 'spark'],
  [31, 67, -8, 18, 6, -22, 620, 'diamond'],
  [89, 61, 20, 13, 6, 20, 660, 'diamond'],
  [56, 34, 4, -18, 5, -28, 700, 'spark'],
  [50, 70, 0, 20, 6, 32, 740, 'diamond'],
  [79, 45, 15, -6, 4, 27, 790, 'diamond'],
  [66, 47, 9, -4, 5, -10, 840, 'spark'],
] as const;

type AchievementStyle = CSSProperties & Readonly<Record<`--achievement-${string}`, string>>;

export function AchievementSequence({ title, kind }: AchievementSequenceProps) {
  const duration = ACHIEVEMENT_SEQUENCE_DURATION_MS[kind];
  const style = { '--achievement-duration': `${duration}ms` } as AchievementStyle;

  return (
    <div
      className='achievement-sequence'
      role='status'
      aria-live='polite'
      aria-atomic='true'
      data-achievement-kind={kind}
      data-achievement-duration-ms={duration}
      style={style}
    >
      {kind === 'yacht' ? (
        <div
          className='achievement-sequence__particles'
          data-achievement-particles='true'
          aria-hidden='true'
        >
          {PARTICLES.map(([x, y, driftX, driftY, size, rotate, delay, shape], index) => (
            <span
              className='achievement-sequence__particle'
              data-particle-shape={shape}
              key={`${shape}-${index}`}
              style={
                {
                  '--achievement-particle-x': `${x}%`,
                  '--achievement-particle-y': `${y}%`,
                  '--achievement-particle-drift-x': `${driftX}px`,
                  '--achievement-particle-drift-y': `${driftY}px`,
                  '--achievement-particle-size': `${size}px`,
                  '--achievement-particle-rotate': `${rotate}deg`,
                  '--achievement-particle-delay': `${delay}ms`,
                } as AchievementStyle
              }
            />
          ))}
        </div>
      ) : null}
      <div className='achievement-sequence__content'>
        <span className='achievement-sequence__flare' aria-hidden='true' />
        <p className='achievement-sequence__title'>{title}</p>
      </div>
    </div>
  );
}
