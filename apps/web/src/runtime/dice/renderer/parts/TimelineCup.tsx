import { useFrame } from '@react-three/fiber';
import { type CupMotion } from '@repo/dice-simulation/contract';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { CupMesh } from '@/runtime/dice/renderer/parts/CupMesh';
import { useRollPlaybackClock } from '@/runtime/dice/renderer/parts/playback-clock';
import {
  createCupFrameSampler,
  cupExitOpacityAt,
} from '@/runtime/dice/renderer/parts/timeline-sampling';
import type { CupResources } from '@/runtime/dice/resources/cup-resources';

export function TimelineCup({ cup, resources }: { cup: CupMotion; resources: CupResources }) {
  const group = useRef<THREE.Group>(null);
  const shellGroup = useRef<THREE.Group>(null);
  const shellMaterials = useRef<THREE.Material[]>([]);
  const shadowCasters = useRef<THREE.Mesh[]>([]);
  const playbackClock = useRollPlaybackClock();
  const sampleFrames = useMemo(() => createCupFrameSampler(cup.frames), [cup.frames]);

  useLayoutEffect(() => {
    const materials = new Set<THREE.Material>();
    const casters: THREE.Mesh[] = [];
    shellGroup.current?.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      objectMaterials.forEach((material) => materials.add(material));
      if (object.castShadow) casters.push(object);
    });
    shellMaterials.current = [...materials];
    shadowCasters.current = casters;
  }, []);

  useFrame(() => {
    if (!group.current) return;
    const elapsedMs = playbackClock.elapsedMs();
    const cupSample = sampleFrames(elapsedMs);
    const exitOpacity = cupExitOpacityAt(elapsedMs, cup.releaseAtMs, cup.exitAtMs);
    if (cupSample.visible) {
      group.current.position.set(cupSample.p[0], cupSample.p[1], cupSample.p[2]);
      group.current.quaternion.set(cupSample.q[0], cupSample.q[1], cupSample.q[2], cupSample.q[3]);
    }
    shellMaterials.current.forEach((material) => {
      const transparent = exitOpacity < 0.999;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        material.needsUpdate = true;
      }
      material.opacity = exitOpacity;
    });
    shadowCasters.current.forEach((mesh) => {
      mesh.castShadow = exitOpacity > 0.45;
    });
    group.current.visible = exitOpacity > 0.001 && (cupSample.visible || elapsedMs < cup.exitAtMs);
  });

  return (
    <group ref={group}>
      <group ref={shellGroup}>
        <CupMesh resources={resources} />
      </group>
    </group>
  );
}
