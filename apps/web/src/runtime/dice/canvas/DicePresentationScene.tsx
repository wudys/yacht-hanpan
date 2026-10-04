import { useThree } from '@react-three/fiber';
import { useLayoutEffect, useSyncExternalStore } from 'react';

import { DICE_REVEAL_DURATION_MS, type DicePresentation } from '@/runtime/dice/dice-presentation';
import { GAME_ROLL_LAYOUT } from '@/runtime/dice/game-dice-layout';
import { DiceRollPlayback, DiceSettledScene } from '@/runtime/dice/renderer';

export function DicePresentationScene({
  presentation,
}: Readonly<{ presentation: DicePresentation }>) {
  const snapshot = useSyncExternalStore(presentation.subscribe, presentation.getSnapshot);
  const { invalidate, setFrameloop } = useThree();
  const animating =
    snapshot.phase === 'revealing' ||
    (snapshot.phase === 'rolling' && snapshot.playback.status === 'verified');

  useLayoutEffect(() => {
    setFrameloop(animating ? 'always' : 'demand');
    if (!animating) invalidate();
  }, [animating, invalidate, setFrameloop, snapshot]);

  if (snapshot.resources === null || snapshot.phase === 'hidden') return null;
  if (snapshot.phase === 'rolling') {
    return (
      <DiceRollPlayback
        key={snapshot.rollId}
        playback={snapshot.playback}
        resources={snapshot.resources}
        layout={GAME_ROLL_LAYOUT}
        onComplete={presentation.completePlayback}
      />
    );
  }
  return (
    <DiceSettledScene
      dice={snapshot.dice}
      resources={snapshot.resources}
      transition={
        snapshot.phase === 'revealing'
          ? {
              timeline: snapshot.playback.timeline,
              layout: GAME_ROLL_LAYOUT,
              durationMs: DICE_REVEAL_DURATION_MS,
            }
          : undefined
      }
    />
  );
}
