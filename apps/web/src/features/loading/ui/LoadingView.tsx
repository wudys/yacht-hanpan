import { BrandLockup } from '@/ui/brand';
import { BouncingDiceLoader } from '@/ui/status/DiceLoader';

export type LoadingViewProps = Readonly<{
  progress: number;
  label: string;
  progressLabel: string;
}>;

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function LoadingView({ progress, label, progressLabel }: LoadingViewProps) {
  const ratio = clampProgress(progress);
  const percentage = Math.floor(ratio * 100);
  return (
    <section className='game-status-view loading-view' role='status'>
      <BrandLockup />
      <BouncingDiceLoader />
      <p className='loading-view__label'>{label}</p>
      <strong className='loading-view__percentage' aria-hidden='true'>
        {percentage}%
      </strong>
      <progress
        className='loading-view__progress'
        max={1}
        value={ratio}
        aria-label={progressLabel}
      />
    </section>
  );
}
