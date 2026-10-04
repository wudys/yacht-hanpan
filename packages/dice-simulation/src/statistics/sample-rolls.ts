import { type DieFace, type DieSlot, POUR_STYLES } from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { simulateRollTimeline } from '../simulate/simulate-timeline';

export type RollSample = Readonly<{
  sequence: number;
  slot: DieSlot;
  face: DieFace;
  finalX: number;
}>;

export async function sampleRolls(sampleCount: number, seedPrefix: string): Promise<RollSample[]> {
  await initializeDeterministicRapierForBun();
  const samples: RollSample[] = [];
  const rolledSlots = [0, 1, 2, 3, 4] as const;

  for (let sequence = 0; sequence < sampleCount; sequence += 1) {
    const timeline = simulateRollTimeline({
      rollId: `${seedPrefix}-${sequence}`,
      seed: `${seedPrefix}-${sequence}`,
      rolledSlots,
      pourStyle: POUR_STYLES[sequence % POUR_STYLES.length],
    });
    for (const die of timeline.dice) {
      samples.push({
        sequence,
        slot: die.slot,
        face: die.value,
        finalX: die.frames.at(-1)!.p[0],
      });
    }
  }

  return samples;
}
