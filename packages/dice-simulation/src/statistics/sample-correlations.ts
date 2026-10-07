import { type DieSlot } from '../contract';
export type AcceptedFaceSample = Readonly<{ acceptedOrdinal: number; slot: DieSlot; face: number }>;

/** Dense accepted coordinates are a projection; attempted coordinates stay in the raw stream. */
export function projectAcceptedFaces(
  samples: readonly Readonly<{ attemptSequence: number; slot: DieSlot; face: number }>[],
): AcceptedFaceSample[] {
  const sequences = [...new Set(samples.map(({ attemptSequence }) => attemptSequence))].sort(
    (a, b) => a - b,
  );
  if (sequences.some((sequence) => !Number.isInteger(sequence) || sequence < 0))
    throw new Error('Unexpected attempt sequence');
  const ordinals = new Map(sequences.map((sequence, ordinal) => [sequence, ordinal]));
  return samples.map(({ attemptSequence, slot, face }) => ({
    acceptedOrdinal: ordinals.get(attemptSequence)!,
    slot,
    face,
  }));
}

export function sampleCorrelations(
  samples: readonly AcceptedFaceSample[],
  rollCount: number,
  expectedSlots: readonly DieSlot[],
) {
  if (!Number.isInteger(rollCount) || rollCount < 3) {
    throw new Error('Correlation diagnostics require at least 3 complete rolls');
  }
  if (
    expectedSlots.length < 1 ||
    expectedSlots.length > 5 ||
    new Set(expectedSlots).size !== expectedSlots.length ||
    expectedSlots.some((slot) => !Number.isInteger(slot) || slot < 0 || slot > 4)
  )
    throw new Error('Expected slots must be 1–5 unique physical slots');
  const rolls = Array.from({ length: rollCount }, () => new Map<DieSlot, number>());
  for (const sample of samples) {
    if (
      !Number.isInteger(sample.acceptedOrdinal) ||
      sample.acceptedOrdinal < 0 ||
      sample.acceptedOrdinal >= rollCount
    ) {
      throw new Error(`Unexpected accepted ordinal ${sample.acceptedOrdinal}`);
    }
    if (!expectedSlots.includes(sample.slot)) {
      throw new Error(`Unexpected slot ${sample.slot} in roll ${sample.acceptedOrdinal}`);
    }
    const roll = rolls[sample.acceptedOrdinal];
    if (roll.has(sample.slot)) {
      throw new Error(`Duplicate slot ${sample.slot} in roll ${sample.acceptedOrdinal}`);
    }
    if (!Number.isFinite(sample.face)) {
      throw new Error(`Non-finite face in roll ${sample.acceptedOrdinal}, slot ${sample.slot}`);
    }
    roll.set(sample.slot, sample.face);
  }
  for (const [sequence, roll] of rolls.entries()) {
    for (const slot of expectedSlots) {
      if (!roll.has(slot)) {
        throw new Error(`Missing slot ${slot} in roll ${sequence}`);
      }
    }
  }

  const facesBySlot = new Map(
    expectedSlots.map((slot) => [slot, rolls.map((roll) => roll.get(slot)!)]),
  );
  const temporal = expectedSlots.map((slot) => ({
    slot,
    pairCount: rollCount - 1,
    correlation: sampleFaceCorrelation(
      facesBySlot.get(slot)!.slice(0, -1),
      facesBySlot.get(slot)!.slice(1),
      `temporal slot ${slot}`,
    ),
  }));
  const withinRoll = expectedSlots.flatMap((leftSlot, leftIndex) =>
    expectedSlots.slice(leftIndex + 1).map((rightSlot) => ({
      slots: [leftSlot, rightSlot] as const,
      pairCount: rollCount,
      correlation: sampleFaceCorrelation(
        facesBySlot.get(leftSlot)!,
        facesBySlot.get(rightSlot)!,
        `within-roll slots ${leftSlot}/${rightSlot}`,
      ),
    })),
  );
  return { temporal, withinRoll };
}

export function sampleFaceCorrelation(
  left: readonly number[],
  right: readonly number[],
  axis: string,
): number {
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
