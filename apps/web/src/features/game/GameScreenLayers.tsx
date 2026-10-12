import type { GameScorePresentation } from '@/features/game/game-presentation';
import type { GameLayer } from '@/features/game/interaction/game-interaction';
import {
  AchievementSequence,
  type AchievementSequenceProps,
} from '@/features/game/ui/AchievementSequence';
import type { GameViewModel } from '@/features/game/ui/game-view-model';
import { BonusInfoPopover } from '@/features/game/ui/score';
import { GameScoreboardView } from '@/features/game/ui/score/GameScoreboardView';
import { SettingsPanel } from '@/features/settings/SettingsPanel';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';
import { Button } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export function GameScoreboardContent({
  rows,
  scores,
  turnLabel,
  locale,
  onClose,
}: Readonly<{
  rows: GameViewModel['scoreRows'];
  scores: GameScorePresentation;
  turnLabel: string;
  locale: Locale;
  onClose: () => void;
}>) {
  return (
    <GameScoreboardView
      rows={rows}
      categories={scores.categories}
      viewer={scores.viewer}
      opponent={scores.opponent}
      labels={scores.scoreLabels}
      title={translate(locale, 'game.view.scoreboard')}
      turnLabel={turnLabel}
      closeLabel={translate(locale, 'common.close')}
      onClose={onClose}
    />
  );
}

// The popover stays inside GameBoard; its outside-dismiss surface remains a sibling overlay.
export function GameBonusPopover({
  subtotal,
  locale,
  onClose,
}: Readonly<{
  subtotal: number;
  locale: Locale;
  onClose: () => void;
}>) {
  return (
    <BonusInfoPopover
      subtotal={subtotal}
      labels={{
        title: translate(locale, 'game.bonusInfo'),
        upperRange: translate(locale, 'game.bonusUpperRange'),
        subtotal: translate(locale, 'game.bonusSubtotal'),
        close: translate(locale, 'common.close'),
      }}
      onClose={onClose}
    />
  );
}

/** Renders local layers; GameScreen retains selection, input guards and effect-consumption state. */
export function GameOverlayLayers({
  layer,
  locale,
  audio,
  preferences,
  commandBlocked,
  recordedCategoryNoticeOpen,
  achievement,
  onClose,
  onForfeit,
  onDismissRecordedCategory,
}: Readonly<{
  layer: GameLayer;
  locale: Locale;
  audio: BrowserAudioRuntime;
  preferences: PreferencesStore;
  commandBlocked: boolean;
  recordedCategoryNoticeOpen: boolean;
  achievement: AchievementSequenceProps | null;
  onClose: () => void;
  onForfeit: () => void;
  onDismissRecordedCategory: () => void;
}>) {
  return (
    <>
      {layer === 'bonus' ? (
        <div className='web-game-bonus-overlay' data-game-bonus-layer='true'>
          <button
            className='web-game-bonus-dismiss'
            type='button'
            aria-label={translate(locale, 'common.close')}
            data-game-bonus-dismiss='true'
            onClick={onClose}
          />
        </div>
      ) : null}
      {layer === 'settings' ? (
        <div className='web-settings-overlay'>
          <SettingsPanel
            audio={audio}
            preferences={preferences}
            onClose={onClose}
            forfeit={{ disabled: commandBlocked, onIntent: onForfeit }}
          />
        </div>
      ) : null}
      {recordedCategoryNoticeOpen ? (
        <div
          className='web-game-category-notice'
          role='alertdialog'
          aria-modal='true'
          aria-label={translate(locale, 'game.recordedCategoryTitle')}
        >
          <ScrollablePanel
            variant='notice'
            title={translate(locale, 'game.recordedCategoryTitle')}
            footer={
              <Button
                label={translate(locale, 'common.confirm')}
                onClick={onDismissRecordedCategory}
              />
            }
          >
            <p>{translate(locale, 'game.recordedCategoryDescription')}</p>
          </ScrollablePanel>
        </div>
      ) : null}
      {achievement ? (
        <div className='web-game-achievement-overlay' data-game-achievement-layer='true'>
          <AchievementSequence {...achievement} />
        </div>
      ) : null}
    </>
  );
}
