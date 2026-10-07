import {
  AUTOMATIC_POUR_STYLES,
  type DieFace,
  type DieSlot,
  parseSimulationInput,
  type PourStyle,
  type RollCandidateRejectionReason,
  type SimulationInput,
} from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { simulateRollPhysics } from '../simulate/simulate-timeline';

export type RollSample = Readonly<{
  sequence: number;
  slot: DieSlot;
  face: DieFace;
  finalX: number;
}>;

export interface RollSampleGroup {
  readonly pourStyle: PourStyle;
  readonly count: number;
  attempted: number;
  accepted: number;
  readonly rejected: {
    readonly sequence: number;
    readonly reason: RollCandidateRejectionReason;
    readonly simulationMs: number;
  }[];
  readonly samples: RollSample[];
}

/** Fixed first-candidate corpus: rejection never generates a replacement input. */
export async function sampleRolls(
  samplesPerGroup: number,
  seedPrefix: string,
): Promise<RollSampleGroup[]> {
  const inputs: SimulationInput[] = [];
  for (const pourStyle of AUTOMATIC_POUR_STYLES) {
    for (let count = 1; count <= 5; count += 1) {
      const rolledSlots = Array.from({ length: count }, (_, index) => index as DieSlot);
      for (let sequence = 0; sequence < samplesPerGroup; sequence += 1) {
        const seed = `${seedPrefix}-${pourStyle}-${count}-${sequence}`;
        inputs.push({ rollId: seed, seed, rolledSlots, pourStyle });
      }
    }
  }
  return sampleRollInputs(inputs);
}

/** Arbitrary regression inputs retain their original sequence and ordered slots. */
export async function sampleRollInputs(
  inputs: readonly SimulationInput[],
): Promise<RollSampleGroup[]> {
  await initializeDeterministicRapierForBun();
  const groups = new Map<string, RollSampleGroup>();
  for (const [sequence, unparsed] of inputs.entries()) {
    const input = parseSimulationInput(unparsed);
    const key = `${input.pourStyle}:${input.rolledSlots.length}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        pourStyle: input.pourStyle,
        count: input.rolledSlots.length,
        attempted: 0,
        accepted: 0,
        rejected: [],
        samples: [],
      };
      groups.set(key, group);
    }
    group.attempted += 1;
    const result = simulateRollPhysics(input, true);
    if (result.status === 'rejected') {
      group.rejected.push({ sequence, reason: result.reason, simulationMs: result.simulationMs });
      continue;
    }
    group.accepted += 1;
    for (const die of result.replay.timeline.dice) {
      group.samples.push({
        sequence,
        slot: die.slot,
        face: die.value,
        finalX: die.frames.at(-1)!.p[0],
      });
    }
  }

  return [...groups.values()];
}
