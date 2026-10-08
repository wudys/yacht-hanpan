import { requireGameAsset } from '@repo/game-assets';
import { UPPER_BONUS_SCORE, UPPER_BONUS_THRESHOLD } from '@repo/yacht-rules';

import { IconButton } from '@/ui/button/IconButton';

export type BonusInfoPopoverProps = Readonly<{
  subtotal: number;
  labels: Readonly<{
    title: string;
    upperRange: string;
    subtotal: string;
    close: string;
  }>;
  onClose: () => void;
}>;

export function BonusInfoPopover({ subtotal, labels, onClose }: BonusInfoPopoverProps) {
  return (
    <section
      className='bonus-info-popover'
      role='dialog'
      aria-label={labels.title}
      data-bonus-info='true'
    >
      <header className='bonus-info-popover__header'>
        <h2>{labels.title}</h2>
        <IconButton
          label={labels.close}
          icon={<img src={requireGameAsset('ui.close').url} alt='' />}
          onClick={onClose}
        />
      </header>
      <div className='bonus-info-popover__details'>
        <div className='bonus-info-popover__subtotal-label'>
          <span className='bonus-info-popover__range' role='img' aria-label={labels.upperRange}>
            <img src={requireGameAsset('score.ones').url} alt='' />
            <span aria-hidden='true'>–</span>
            <img src={requireGameAsset('score.sixes').url} alt='' />
          </span>
          <span>{labels.subtotal}</span>
        </div>
        <span
          className='bonus-info-popover__value'
          data-bonus-subtotal={subtotal}
          data-bonus-threshold={UPPER_BONUS_THRESHOLD}
          data-bonus-progress='true'
        >
          {`${subtotal}/${UPPER_BONUS_THRESHOLD}`}
        </span>
        <span className='bonus-info-popover__arrow' aria-hidden='true'>
          →
        </span>
        <span className='bonus-info-popover__award' data-bonus-award={UPPER_BONUS_SCORE}>
          {`+${UPPER_BONUS_SCORE}`}
        </span>
      </div>
    </section>
  );
}
