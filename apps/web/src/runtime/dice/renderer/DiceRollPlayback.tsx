import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';

import type { RollStageLayout } from '@/runtime/dice/game-dice-layout';
import { DiceSettledScene } from '@/runtime/dice/renderer/DiceSettledScene';
import { DiceCupModel } from '@/runtime/dice/renderer/parts/DiceCupModel';
import {
  RollPlaybackClockProvider,
  useRollPlaybackClock,
} from '@/runtime/dice/renderer/parts/playback-clock';
import { RollStage } from '@/runtime/dice/renderer/parts/RollStage';
import { TimelineDie } from '@/runtime/dice/renderer/parts/TimelineDie';
import type { RollPlayback } from '@/runtime/dice/replay/resolve-playback';
import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

type DiceRollPlaybackProps = Readonly<{
  playback: RollPlayback;
  resources: ProceduralDiceResources;
  layout?: RollStageLayout;
  onComplete?: (rollId: string) => void;
}>;

export function DiceRollPlayback({
  playback,
  resources,
  layout,
  onComplete,
}: DiceRollPlaybackProps) {
  if (playback.status === 'static-fallback') {
    return (
      <group name={`roll-fallback-${playback.rollId}`}>
        <DiceSettledScene dice={playback.dice} resources={resources} />
      </group>
    );
  }

  const { timeline } = playback;
  return (
    <RollPlaybackClockProvider key={timeline.rollId}>
      <PlaybackDriver
        rollId={timeline.rollId}
        durationMs={timeline.durationMs}
        onComplete={onComplete}
      />
      <RollStage rollArea={timeline.rollArea} layout={layout}>
        <DiceCupModel cup={timeline.cup} resources={resources.cup} />
        {timeline.dice.map((die) => (
          <TimelineDie key={`${timeline.rollId}-${die.slot}`} die={die} resources={resources} />
        ))}
      </RollStage>
    </RollPlaybackClockProvider>
  );
}

function PlaybackDriver({
  rollId,
  durationMs,
  onComplete,
}: Readonly<{
  rollId: string;
  durationMs: number;
  onComplete?: DiceRollPlaybackProps['onComplete'];
}>) {
  const clock = useRollPlaybackClock();
  const completed = useRef(false);

  useEffect(() => {
    completed.current = false;
    clock.start();
  }, [clock, rollId]);

  useFrame(() => {
    if (completed.current || clock.elapsedMs() < durationMs) return;
    completed.current = true;
    onComplete?.(rollId);
  });

  return null;
}
