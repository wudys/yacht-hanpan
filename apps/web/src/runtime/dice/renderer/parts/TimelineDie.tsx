import { useFrame } from '@react-three/fiber';
import { DIE_GEOMETRY, type DieTimeline } from '@repo/dice-simulation/contract';
import { useRef } from 'react';
import * as THREE from 'three';

import { DieMesh } from '@/runtime/dice/renderer/parts/DieVisual';
import { useRollPlaybackClock } from '@/runtime/dice/renderer/parts/playback-clock';
import { sampleFrames } from '@/runtime/dice/renderer/parts/timeline-sampling';
import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

interface TimelineDieProps {
  die: DieTimeline;
  resources: ProceduralDiceResources;
}

export function TimelineDie({ die, resources }: TimelineDieProps) {
  const group = useRef<THREE.Group>(null);
  const playbackClock = useRollPlaybackClock();

  useFrame(() => {
    if (!group.current) return;
    const elapsedMs = playbackClock.elapsedMs();
    const sample = sampleFrames(die.frames, elapsedMs);
    group.current.position.set(sample.p[0], sample.p[1], sample.p[2]);
    group.current.quaternion.set(sample.q[0], sample.q[1], sample.q[2], sample.q[3]);
    group.current.visible = sample.visible;
  });

  return (
    <group ref={group} scale={DIE_GEOMETRY.size}>
      <DieMesh resources={resources} />
    </group>
  );
}
