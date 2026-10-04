import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { actionIdSchema, turnIdSchema } from '../internal/primitives';
import { CATEGORY_IDS } from '../state/constants';

export const GAME_COMMAND_TYPE = {
  ROLL_DICE: 'rollDice',
  SET_DIE_HELD: 'setDieHeld',
  SELECT_SCORE_CATEGORY: 'selectScoreCategory',
  FORFEIT_MATCH: 'forfeitMatch',
} as const;

const commandIdentityEntries = {
  actionId: actionIdSchema,
  turnId: turnIdSchema,
} as const;

const rollDiceSchema = v.strictObject({
  type: v.literal(GAME_COMMAND_TYPE.ROLL_DICE),
  ...commandIdentityEntries,
});

const setDieHeldSchema = v.strictObject({
  type: v.literal(GAME_COMMAND_TYPE.SET_DIE_HELD),
  ...commandIdentityEntries,
  slot: v.picklist([0, 1, 2, 3, 4]),
  isHeld: v.boolean(),
});

const selectScoreCategorySchema = v.strictObject({
  type: v.literal(GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY),
  ...commandIdentityEntries,
  categoryId: v.picklist(CATEGORY_IDS),
});

const forfeitMatchSchema = v.strictObject({
  type: v.literal(GAME_COMMAND_TYPE.FORFEIT_MATCH),
  actionId: actionIdSchema,
});

const gameCommandSchema = v.variant('type', [
  rollDiceSchema,
  setDieHeldSchema,
  selectScoreCategorySchema,
  forfeitMatchSchema,
]);

export type GameCommand = v.InferOutput<typeof gameCommandSchema>;

export const parseGameCommand = (value: unknown): GameCommand =>
  parseWith(gameCommandSchema, value);

export { gameCommandSchema };
