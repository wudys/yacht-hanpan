import { type DieSlot } from '../contract';
import { type RollSample } from './sample-rolls';

const SLOTS = [0, 1, 2, 3, 4] as const;

export function sampleCorrelations(samples: readonly RollSample[], rollCount: number) {
  if (!Number.isInteger(rollCount) || rollCount < 3) {
    throw new Error('Correlation diagnostics require at least 3 complete rolls');
  }
  const rolls = Array.from({ length: rollCount }, () => new Map<DieSlot, number>());
  for (const sample of samples) {
    if (!Number.isInteger(sample.sequence) || sample.sequence < 0 || sample.sequence >= rollCount) {
      throw new Error(`Unexpected roll sequence ${sample.sequence}`);
    }
    if (!SLOTS.includes(sample.slot)) {
      throw new Error(`Unexpected slot ${sample.slot} in roll ${sample.sequence}`);
    }
    const roll = rolls[sample.sequence];
    if (roll.has(sample.slot)) {
      throw new Error(`Duplicate slot ${sample.slot} in roll ${sample.sequence}`);
    }
    if (!Number.isFinite(sample.face)) {
      throw new Error(`Non-finite face in roll ${sample.sequence}, slot ${sample.slot}`);
    }
    roll.set(sample.slot, sample.face);
  }
  for (const [sequence, roll] of rolls.entries()) {
    for (const slot of SLOTS) {
      if (!roll.has(slot)) {
        throw new Error(`Missing slot ${slot} in roll ${sequence}`);
      }
    }
  }

  const facesBySlot = SLOTS.map((slot) => rolls.map((roll) => roll.get(slot)!));
  const temporal = SLOTS.map((slot) => ({
    slot,
    pairCount: rollCount - 1,
    correlation: correlation(
      facesBySlot[slot].slice(0, -1),
      facesBySlot[slot].slice(1),
      `temporal slot ${slot}`,
    ),
  }));
  const withinRoll = SLOTS.flatMap((leftSlot) =>
    SLOTS.filter((rightSlot) => rightSlot > leftSlot).map((rightSlot) => ({
      slots: [leftSlot, rightSlot] as const,
      pairCount: rollCount,
      correlation: correlation(
        facesBySlot[leftSlot],
        facesBySlot[rightSlot],
        `within-roll slots ${leftSlot}/${rightSlot}`,
      ),
    })),
  );
  return { temporal, withinRoll };
}

function correlation(left: readonly number[], right: readonly number[], axis: string): number {
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  const value = numerator / denominator;
  if (!Number.isFinite(denominator) || denominator === 0 || !Number.isFinite(value)) {
    throw new Error(`Undefined correlation for ${axis}, ${left.length} pairs`);
  }
  return value;
}
