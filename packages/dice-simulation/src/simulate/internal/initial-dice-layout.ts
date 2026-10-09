import { seededNumber } from './seed-expander';

export type InitialDiePlacement = Readonly<{
  x: number;
  z: number;
  layer: 0 | 1;
}>;

// P02, P26, P13 and P32. Each preset lists the lower pair before the upper three.
const FIVE_DICE_LAYOUT_PRESETS = [
  [
    [-0.458006, 0.381111],
    [0.30676, 0.436437],
    [-0.216356, 0.129985],
    [0.023016, -0.632554],
    [0.606604, 0.116025],
  ],
  [
    [0.607318, 0.19111],
    [-0.226725, 0.54128],
    [0.18105, -0.30721],
    [0.111157, 0.574353],
    [-0.644179, -0.018837],
  ],
  [
    [-0.218415, 0.518905],
    [-0.222593, -0.448887],
    [-0.231739, 0.566586],
    [-0.524209, -0.247036],
    [0.567669, 0.242682],
  ],
  [
    [-0.496206, 0.286821],
    [0.614425, -0.105469],
    [-0.168518, -0.605437],
    [0.15779, 0.205767],
    [-0.586112, 0.227689],
  ],
] as const;

export function createInitialDiceLayout(
  seed: string,
  diceCount: number,
): readonly InitialDiePlacement[] {
  if (diceCount === 5) {
    const presetIndex = Math.min(
      FIVE_DICE_LAYOUT_PRESETS.length - 1,
      Math.floor(seededNumber(`${seed}:cup-layout-preset`, 0) * FIVE_DICE_LAYOUT_PRESETS.length),
    );
    const preset = FIVE_DICE_LAYOUT_PRESETS[presetIndex]!;
    const orderedDice = Array.from({ length: diceCount }, (_, dieIndex) => ({
      dieIndex,
      sample: seededNumber(`${seed}:free-layout-seat`, dieIndex),
    })).sort((a, b) => a.sample - b.sample || a.dieIndex - b.dieIndex);
    const placements = new Array<InitialDiePlacement>(diceCount);
    orderedDice.forEach(({ dieIndex }, placementIndex) => {
      const [x, z] = preset[placementIndex]!;
      placements[dieIndex] = { x, z, layer: placementIndex < 2 ? 0 : 1 };
    });
    return placements;
  }
  return Array.from({ length: diceCount }, (_, dieIndex): InitialDiePlacement => {
    if (diceCount === 1) return { x: 0, z: 0, layer: 0 };
    if (diceCount === 2) return { x: dieIndex === 0 ? -0.4 : 0.4, z: 0, layer: 0 };
    if (diceCount === 3) {
      const angle = (dieIndex * Math.PI * 2) / 3;
      return { x: Math.cos(angle) * 0.55, z: Math.sin(angle) * 0.55, layer: 0 };
    }
    return {
      x: dieIndex % 2 ? 0.42 : -0.42,
      z: dieIndex < 2 ? -0.42 : 0.42,
      layer: 0,
    };
  });
}
