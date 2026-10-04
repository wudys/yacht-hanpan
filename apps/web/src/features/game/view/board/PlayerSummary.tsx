import { requireGameAsset } from '@repo/game-assets';
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react';

import { IconButton } from '@/ui/button';
import { PlayerAvatar } from '@/ui/profile';

export type PlayerSummaryProps = Readonly<{
  player: Readonly<{ imageUrl?: string; imageAlt: string; selfLabel?: string }>;
  labels: Readonly<{
    total: string;
    bonus: string;
    bonusStatus: string;
    bonusInfo: string;
    turnState: string;
    scoreboard: string;
  }>;
  isViewerTurn: boolean;
  bonusEarned: boolean;
  emphasized: boolean;
  bonusPopover?: ReactNode;
  onOpenBonus?: () => void;
  onOpenScoreboard?: () => void;
}>;

export function PlayerSummary({
  player,
  labels,
  isViewerTurn,
  bonusEarned,
  emphasized,
  bonusPopover,
  onOpenBonus,
  onOpenScoreboard,
}: PlayerSummaryProps) {
  const bonusStatusId = useId();
  const summaryRef = useRef<HTMLElement>(null);
  const bonusLabelRef = useRef<HTMLSpanElement>(null);
  const bonusAnchorRef = useRef<HTMLDivElement>(null);
  const bonusActionRef = useRef<HTMLButtonElement>(null);
  const bonusPopoverRef = useRef<HTMLDivElement>(null);
  const isBonusOpen = Boolean(bonusPopover);

  useLayoutEffect(() => {
    const summary = summaryRef.current;
    const label = bonusLabelRef.current;
    const anchor = bonusAnchorRef.current;
    const action = bonusActionRef.current;
    const popover = bonusPopoverRef.current;
    if (!summary || !label || !anchor || !action || !popover) return;

    const alignPopover = () => {
      const summaryRect = summary.getBoundingClientRect();
      if (summaryRect.width === 0) return;
      const labelRect = label.getBoundingClientRect();
      const anchorRect = anchor.getBoundingClientRect();
      const scale = summaryRect.width / summary.offsetWidth;
      const centered =
        (labelRect.left + labelRect.width / 2 - summaryRect.left) / scale - popover.offsetWidth / 2;
      const left = Math.max(0, Math.min(centered, summary.clientWidth - popover.offsetWidth));
      popover.style.left = `${left - (anchorRect.left - summaryRect.left) / scale}px`;
      popover.style.top = `${(labelRect.bottom - anchorRect.top) / scale + 8}px`;
      popover.style.setProperty(
        '--bonus-pointer-left',
        `${(labelRect.left + labelRect.width / 2 - summaryRect.left) / scale - left}px`,
      );
    };

    alignPopover();
    const observer = new ResizeObserver(alignPopover);
    observer.observe(summary);
    observer.observe(action);
    observer.observe(popover);
    return () => observer.disconnect();
  }, [isBonusOpen, labels.bonus, labels.total, labels.turnState]);

  return (
    <section
      className='player-summary'
      ref={summaryRef}
      role='group'
      aria-label={`${labels.total} · ${labels.bonusStatus}`}
      data-game-band='summary'
      data-player-summary={isViewerTurn ? 'viewer' : 'opponent'}
      data-summary-emphasized={emphasized ? 'true' : 'false'}
    >
      <PlayerAvatar
        imageUrl={player.imageUrl}
        alt={player.imageAlt}
        selfLabel={player.selfLabel}
        size='sm'
      />
      <strong className='player-summary__turn'>{labels.turnState}</strong>
      <span className='player-summary__score'>{labels.total}</span>
      <div className='player-summary__bonus-anchor' ref={bonusAnchorRef} data-open={isBonusOpen}>
        <button
          className='player-summary__bonus-action'
          ref={bonusActionRef}
          data-bonus-info-action='true'
          type='button'
          aria-label={labels.bonusInfo}
          aria-describedby={bonusStatusId}
          aria-haspopup='dialog'
          aria-expanded={isBonusOpen}
          onClick={onOpenBonus}
        >
          <span className='player-summary__bonus' ref={bonusLabelRef} data-earned={bonusEarned}>
            <span
              className='player-summary__bonus-icon'
              aria-hidden='true'
              style={{
                maskImage: `url("${requireGameAsset(bonusEarned ? 'ui.bonus-check-active' : 'ui.bonus-check-inactive').url}")`,
              }}
            />
            {labels.bonus}
          </span>
        </button>
        <span id={bonusStatusId} hidden>
          {labels.bonusStatus}
        </span>
        {isBonusOpen ? (
          <div className='player-summary__bonus-popover' ref={bonusPopoverRef}>
            {bonusPopover}
          </div>
        ) : null}
      </div>
      <IconButton
        label={labels.scoreboard}
        icon={<img src={requireGameAsset('ui.scoreboard').url} alt='' />}
        onClick={onOpenScoreboard}
      />
    </section>
  );
}
