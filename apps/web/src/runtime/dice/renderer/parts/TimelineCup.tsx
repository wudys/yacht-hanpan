import { useFrame } from '@react-three/fiber';
import { type CupMotion, DEFAULT_CUP_GEOMETRY } from '@repo/dice-simulation/contract';
import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { useRollPlaybackClock } from '@/runtime/dice/renderer/parts/playback-clock';
import {
  createCupFrameSampler,
  cupExitOpacityAt,
} from '@/runtime/dice/renderer/parts/timeline-sampling';
import type { CupResources } from '@/runtime/dice/resources/cup-resources';

const CUP_COLORS = {
  outer: '#624b3a',
  base: '#514132',
  rim: '#c98e31',
  inner: '#24614d',
} as const;

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
        <DiceCupShell resources={resources} />
      </group>
    </group>
  );
}

export function DiceCupShell({ resources: { geometry, texture } }: { resources: CupResources }) {
  const spec = DEFAULT_CUP_GEOMETRY;
  const halfHeight = spec.innerHeight / 2;
  // These radii, heights and polygon segments are the physical wall profile,
  // not an independent decorative well. Opaque surfaces handle die occlusion.
  return (
    <group>
      <mesh castShadow receiveShadow>
        <primitive attach='geometry' object={geometry.outer} />
        {/* The shell is open at the mouth: back-face-only shadow casting leaks light
            through rays that enter the outside and leave through the opening. */}
        <meshStandardMaterial
          color={CUP_COLORS.outer}
          roughness={0.62}
          metalness={0.02}
          shadowSide={THREE.DoubleSide}
        />
      </mesh>
      <mesh receiveShadow>
        <primitive attach='geometry' object={geometry.inner} />
        <meshStandardMaterial color={CUP_COLORS.inner} roughness={0.94} side={THREE.BackSide} />
      </mesh>
      <mesh position={[0, -halfHeight - spec.baseThickness / 2, 0]} castShadow receiveShadow>
        <primitive attach='geometry' object={geometry.base} />
        <meshStandardMaterial color={CUP_COLORS.base} roughness={0.82} />
      </mesh>
      <mesh position={[0, -halfHeight + 0.001, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <primitive attach='geometry' object={geometry.floor} />
        <meshStandardMaterial map={texture} color='#d3e8c9' roughness={0.96} />
      </mesh>
      <mesh position={[0, halfHeight, 0]} rotation={[-Math.PI / 2, 0, 0]} castShadow receiveShadow>
        <primitive attach='geometry' object={geometry.rim} />
        <meshStandardMaterial
          color={CUP_COLORS.rim}
          roughness={0.48}
          metalness={0.1}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
