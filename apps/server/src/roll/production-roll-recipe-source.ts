import { randomBytes, randomInt } from 'node:crypto';

import { AUTOMATIC_POUR_STYLES } from '@repo/dice-simulation/contract';
import { v7 as uuidV7 } from 'uuid';

import type { RollRecipeSource } from '@/roll/authoritative-roll-command-executor';

export function createProductionRollRecipeSource(): RollRecipeSource {
  return {
    createRollId: uuidV7,
    createRollSeed: () => randomBytes(16).toString('hex'),
    createPourStyle: () => AUTOMATIC_POUR_STYLES[randomInt(AUTOMATIC_POUR_STYLES.length)]!,
  };
}
