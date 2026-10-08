import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

export function DieMesh({ resources }: { resources: ProceduralDiceResources }) {
  return (
    <mesh
      castShadow
      receiveShadow
      geometry={resources.dieGeometry}
      material={resources.dieMaterials}
      dispose={null}
    />
  );
}
