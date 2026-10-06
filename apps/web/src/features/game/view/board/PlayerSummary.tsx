import { requireGameAsset } from '@repo/game-assets';
import { type ReactNode, useId, useLayoutEffect, useRef } from 'react';

import { BonusRecordEffect, RecordTransition } from '@/features/game/view/score/RecordFeedback';
import type { ScoreDisplayOwner, ScoreRecordFeedback } from '@/features/game/view/score/types';
import { IconButton } from '@/ui/button';
import { PlayerAvatar } from '@/ui/profile';

export type PlayerSummaryProps = Readonly<{
  recordFeedback?: ScoreRecordFeedback | null;
  player: Readonly<{ imageUrl?: string; imageAlt: string; label: string }>;
  labels: Readonly<{
    total: string;
    bonus: string;
    bonusStatus: string;
    bonusInfo: string;
    scoreboard: string;
  }>;
  displayOwner: ScoreDisplayOwner;
  bonusEarned: boolean;
  bonusPopover?: ReactNode;
  onOpenBonus?: () => void;
  onOpenScoreboard?: () => void;
}>;

export function PlayerSummary({
  player,
  recordFeedback,
  labels,
  displayOwner,
  bonusEarned,
  bonusPopover,
  onOpenBonus,
  onOpenScoreboard,
}: PlayerSummaryProps) {
  const transitionKey = `${recordFeedback?.identity ?? 'idle'}:${recordFeedback?.phase ?? 'idle'}`;
  const celebrateBonus = recordFeedback?.bonusEarned && recordFeedback.phase !== 'incoming';
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
  }, [isBonusOpen, labels.bonus, labels.total, player.label, transitionKey]);

  return (
    <section
      className='player-summary'
      ref={summaryRef}
      role='group'
      aria-label={`${labels.total} · ${labels.bonusStatus}`}
      data-game-band='summary'
      data-player-summary={displayOwner}
    >
      <RecordTransition
        key={`identity:${transitionKey}`}
        feedback={recordFeedback}
        className='player-summary__identity'
      >
        <PlayerAvatar imageUrl={player.imageUrl} alt={player.imageAlt} size='sm' />
        <strong className='player-summary__identity-label'>{player.label}</strong>
      </RecordTransition>
      <RecordTransition
        key={`score:${transitionKey}`}
        feedback={recordFeedback}
        className='player-summary__score'
      >
        {labels.total}
      </RecordTransition>
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
          <RecordTransition
            key={`bonus:${transitionKey}`}
            feedback={recordFeedback}
            className='player-summary__bonus'
            ref={bonusLabelRef}
            data-earned={bonusEarned}
          >
            <span
              className='player-summary__bonus-icon'
              aria-hidden='true'
              style={{
                maskImage: `url("${requireGameAsset(bonusEarned ? 'ui.bonus-check-active' : 'ui.bonus-check-inactive').url}")`,
              }}
            />
            {labels.bonus}
            {celebrateBonus && recordFeedback ? (
              <BonusRecordEffect key={recordFeedback.identity} feedback={recordFeedback} />
            ) : null}
          </RecordTransition>
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
