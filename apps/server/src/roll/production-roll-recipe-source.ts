import { randomBytes, randomInt } from 'node:crypto';

import { POUR_STYLE, POUR_STYLES } from '@repo/dice-simulation/contract';
import { v7 as uuidV7 } from 'uuid';

import type { RollRecipeSource } from '@/roll/authoritative-roll-command-executor';

export function createProductionRollRecipeSource(): RollRecipeSource {
  return {
    createRollId: uuidV7,
    createRollSeed: () => randomBytes(16).toString('hex'),
    createPourStyle: (diceCount) =>
      diceCount === 1 ? POUR_STYLE.BURST : POUR_STYLES[randomInt(POUR_STYLES.length)]!,
  };
}
