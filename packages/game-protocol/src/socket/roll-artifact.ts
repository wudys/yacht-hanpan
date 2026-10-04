import { DICE_SIMULATION_CONTRACT, type DieSlot, POUR_STYLE } from '@repo/dice-simulation/contract';
import * as v from 'valibot';

import { parseWith } from '../internal/parse';
import { rollIdSchema } from '../internal/primitives';
import type { DeepReadonly } from '../internal/readonly';
import { MATCH_STATUS } from '../state/constants';
import type { GameSnapshot } from '../state/room-view';
import { compatibilityContractSchema } from '../version/validation';

export const RESOLVED_ROLL_TYPE = {
  RESOLVED: 'roll:resolved',
  REPLAY_MODE: 'seeded-physics',
} as const;

const dieSlotSchema = v.picklist([0, 1, 2, 3, 4]);
const dieFaceSchema = v.picklist([1, 2, 3, 4, 5, 6]);
const rolledSlotsSchema = v.pipe(v.array(dieSlotSchema), v.minLength(1), v.maxLength(5));
const rolledFaceSchema = v.strictObject({ slot: dieSlotSchema, value: dieFaceSchema });
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;

const resolvedRollArtifactSchema = v.pipe(
  v.strictObject({
    type: v.literal(RESOLVED_ROLL_TYPE.RESOLVED),
    replay: v.strictObject({
      mode: v.literal(RESOLVED_ROLL_TYPE.REPLAY_MODE),
      rollId: rollIdSchema,
      seed: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(128),
        v.check((value) => value.trim() === value),
      ),
      pourStyle: v.picklist([POUR_STYLE.CLASSIC, POUR_STYLE.BURST, POUR_STYLE.OBLIQUE]),
      rolledSlots: rolledSlotsSchema,
      contract: compatibilityContractSchema,
    }),
    outcome: v.strictObject({
      authoritativeValuesBySlot: v.pipe(v.array(rolledFaceSchema), v.minLength(1), v.maxLength(5)),
    }),
    replayDigest: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
  }),
  v.check((artifact) => {
    const replaySlots = artifact.replay.rolledSlots;
    const outcomeSlots = artifact.outcome.authoritativeValuesBySlot.map(({ slot }) => slot);
    const digestParts = artifact.replayDigest.split(':');
    return (
      digestParts.length === 2 &&
      digestParts[0] === DICE_SIMULATION_CONTRACT.replayDigestVersion &&
      SHA256_HEX_PATTERN.test(digestParts[1] ?? '') &&
      outcomeSlots.length === replaySlots.length &&
      isStrictlyAscending(replaySlots) &&
      isStrictlyAscending(outcomeSlots) &&
      replaySlots.every((slot, index) => outcomeSlots[index] === slot)
    );
  }),
);

export type ResolvedRollArtifact = DeepReadonly<v.InferOutput<typeof resolvedRollArtifactSchema>>;

export function rollMatchesGameSnapshot(
  snapshot: GameSnapshot | null,
  roll: ResolvedRollArtifact,
): boolean {
  if (snapshot?.match.status !== MATCH_STATUS.PLAYING) return false;
  const { dice } = snapshot.match.currentTurn;
  return (
    dice !== null &&
    roll.outcome.authoritativeValuesBySlot.every(({ slot, value }) => dice[slot].value === value)
  );
}

function isStrictlyAscending(slots: readonly DieSlot[]): boolean {
  return slots.every((slot, index) => index === 0 || slots[index - 1]! < slot);
}

export function parseResolvedRollArtifact(value: unknown): ResolvedRollArtifact {
  return parseWith(resolvedRollArtifactSchema, value);
}

export { resolvedRollArtifactSchema };
