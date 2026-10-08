import type { DieSlot } from '@repo/yacht-rules';

import type { DiceViewModel } from '@/features/game/ui/game-view-model';
import { DICE_CANVAS_VIEWPORT_SIZE, layoutSettledDice } from '@/runtime/dice/game-dice-layout';

export function SettledDiceControls({
  dice,
  label,
  canHold,
  interactionLocked,
  onSetDieHeld,
}: Readonly<{
  dice: readonly [] | DiceViewModel;
  label: string;
  canHold: boolean;
  interactionLocked: boolean;
  onSetDieHeld: (slot: DieSlot, isHeld: boolean) => void;
}>) {
  const layout = layoutSettledDice(
    dice.filter((die) => !die.held),
    DICE_CANVAS_VIEWPORT_SIZE,
  );
  return (
    <div className='settled-dice-controls' data-authoritative-dice-stage='true'>
      {layout.map((die) => (
        <button
          className='settled-die-control'
          type='button'
          key={die.slot}
          data-settled-slot={die.slot}
          data-authoritative-die-slot={die.slot}
          data-die-face={die.value}
          data-interaction-locked={canHold && interactionLocked ? 'true' : 'false'}
          aria-label={`${label} ${die.slot + 1}: ${die.value}`}
          aria-pressed='false'
          disabled={!canHold || interactionLocked}
          style={{ left: die.centerPx.x, top: die.centerPx.y }}
          onClick={() => onSetDieHeld(die.slot, true)}
        />
      ))}
    </div>
  );
}
