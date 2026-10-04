import { DEFAULT_CUP_GEOMETRY } from '@repo/dice-simulation/contract';
import * as THREE from 'three';

import type { CupResources } from '@/runtime/dice/resources/cup-resources';

const CUP_COLORS = {
  outer: '#624b3a',
  base: '#514132',
  rim: '#c98e31',
  inner: '#24614d',
} as const;

export function CupMesh({ resources: { geometry, texture } }: { resources: CupResources }) {
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
