import { useFrame, useThree } from '@react-three/fiber';
import type { RollTimeline } from '@repo/dice-simulation/contract';
import { useLayoutEffect, useRef, useState } from 'react';
import { type Mesh, Quaternion } from 'three';

import {
  layoutSettledDice,
  type RollStageLayout,
  SETTLED_STAGE_AREA,
  SETTLED_STAGE_LAYOUT,
  type SettledDie,
  type SettledDieLayout,
} from '@/runtime/dice/game-dice-layout';
import { TOP_FACE_QUATERNION } from '@/runtime/dice/renderer/parts/die-display-pose';
import { RollStage } from '@/runtime/dice/renderer/parts/RollStage';
import { projectPhysicalDieToSettled } from '@/runtime/dice/renderer/parts/settled-dice-transition';
import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

type SettledTransition = Readonly<{
  timeline: RollTimeline;
  layout: RollStageLayout;
  durationMs: number;
}>;

type DiceSettledSceneProps = Readonly<{
  dice: readonly SettledDie[];
  resources: ProceduralDiceResources;
  transition?: SettledTransition;
}>;

export function DiceSettledScene({ dice, resources, transition }: DiceSettledSceneProps) {
  const { size } = useThree();
  const layout = layoutSettledDice(dice, size);
  return (
    <group name='dice-settled-scene'>
      <RollStage rollArea={SETTLED_STAGE_AREA} layout={SETTLED_STAGE_LAYOUT}>
        {layout.map((die) => (
          <SettledDieMesh
            key={`${die.slot}:${die.value}`}
            die={die}
            resources={resources}
            transition={transition}
          />
        ))}
      </RollStage>
    </group>
  );
}

function SettledDieMesh({
  die,
  resources,
  transition,
}: Readonly<{
  die: SettledDieLayout;
  resources: ProceduralDiceResources;
  transition?: SettledTransition;
}>) {
  const { size } = useThree();
  const mesh = useRef<Mesh>(null);
  const elapsedMs = useRef(0);
  // Capture the physical starting pose once; every path ends at the same icon pose.
  const [pose] = useState(() => {
    const frame = transition?.timeline.dice.find((item) => item.slot === die.slot)?.frames.at(-1);
    return {
      frame,
      quaternion: new Quaternion(...TOP_FACE_QUATERNION[die.value]),
    };
  });
  const source =
    transition && pose.frame
      ? projectPhysicalDieToSettled(
          pose.frame,
          transition.timeline.rollArea,
          transition.layout,
          size,
        )
      : null;

  const applyPose = (progress: number) => {
    if (!mesh.current) return;
    // Make room in the row before enlarging: simultaneous early growth makes
    // crossing trajectories intersect as full-size cubes.
    const travel = Math.min(1, progress / 0.65);
    const alpha = 1 - (1 - travel) ** 3;
    const growth = Math.max(0, Math.min(1, (progress - 0.35) / 0.65));
    const scaleAlpha = growth * growth * (3 - 2 * growth);
    const start = source?.position ?? die.position;
    mesh.current.position.set(
      start[0] + (die.position[0] - start[0]) * alpha,
      start[1] + (die.position[1] - start[1]) * alpha,
      start[2] + (die.position[2] - start[2]) * alpha,
    );
    const scale = source?.scale ?? die.scale;
    mesh.current.scale.setScalar(scale + (die.scale - scale) * scaleAlpha);
    if (source && pose.frame) {
      mesh.current.quaternion.fromArray(pose.frame.q).normalize().slerp(pose.quaternion, alpha);
    } else {
      mesh.current.quaternion.copy(pose.quaternion);
    }
  };

  useLayoutEffect(() => {
    applyPose(transition ? Math.min(1, elapsedMs.current / transition.durationMs) : 1);
  });
  useFrame((_, delta) => {
    if (!transition) return;
    elapsedMs.current += delta * 1000;
    applyPose(Math.min(1, elapsedMs.current / transition.durationMs));
  });

  return (
    <mesh
      ref={mesh}
      name={`settled-die-${die.slot}`}
      geometry={resources.dieGeometry}
      material={resources.dieMaterials}
      castShadow
      dispose={null}
    />
  );
}
