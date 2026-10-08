import { DEFAULT_CUP_GEOMETRY, DIE_GEOMETRY, ROLL_AREA } from '@repo/dice-simulation/contract';
import * as THREE from 'three';

import { CupMesh } from '@/runtime/dice/renderer/parts/CupMesh';
import { DiceStage } from '@/runtime/dice/renderer/parts/DiceStage';
import { DieMesh } from '@/runtime/dice/renderer/parts/DieMesh';
import type { ProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

type DiceWarmupSceneProps = Readonly<{
  visible?: boolean;
  resources: ProceduralDiceResources;
}>;

const WARMUP_CENTER_Z = ROLL_AREA.centerZ ?? ROLL_AREA.depth / 2;
const WARMUP_CUP_POSITION = new THREE.Vector3(
  0,
  DEFAULT_CUP_GEOMETRY.innerHeight / 2,
  WARMUP_CENTER_Z,
);

export function DiceWarmupScene({ visible = true, resources }: DiceWarmupSceneProps) {
  return (
    <group name='dice-roll-warmup' visible={visible}>
      <DiceStage rollArea={ROLL_AREA}>
        <group position={WARMUP_CUP_POSITION}>
          <CupMesh resources={resources.cup} />
        </group>
        <WarmupDie variant='outside' resources={resources} />
        <WarmupDie variant='inside' resources={resources} />
      </DiceStage>
    </group>
  );
}

function WarmupDie({
  variant,
  resources,
}: {
  variant: 'outside' | 'inside';
  resources: ProceduralDiceResources;
}) {
  const inside = variant === 'inside';
  return (
    <group
      position={inside ? [0, 0.62, WARMUP_CENTER_Z] : [1.86, 0, WARMUP_CENTER_Z]}
      scale={DIE_GEOMETRY.size}
    >
      <DieMesh resources={resources} />
    </group>
  );
}
