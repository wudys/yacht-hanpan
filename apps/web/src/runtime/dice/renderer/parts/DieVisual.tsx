import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

type DieVisualProps = Readonly<{
  position?: [number, number, number];
  size: number;
  resources: ProceduralDiceResources;
}>;

export function DieVisual({ position = [0, 0, 0], size, resources }: DieVisualProps) {
  return (
    <group position={position} scale={size}>
      <DieMesh resources={resources} />
    </group>
  );
}

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
