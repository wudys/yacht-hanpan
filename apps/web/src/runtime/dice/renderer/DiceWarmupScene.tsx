import { DEFAULT_CUP_GEOMETRY, DIE_GEOMETRY, ROLL_AREA } from '@repo/dice-simulation/contract';
import * as THREE from 'three';

import { CupMesh } from '@/runtime/dice/renderer/parts/CupMesh';
import { DieVisual } from '@/runtime/dice/renderer/parts/DieVisual';
import { RollStage } from '@/runtime/dice/renderer/parts/RollStage';
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
      <RollStage rollArea={ROLL_AREA}>
        <group position={WARMUP_CUP_POSITION}>
          <CupMesh resources={resources.cup} />
        </group>
        <WarmupDie variant='outside' resources={resources} />
        <WarmupDie variant='inside' resources={resources} />
      </RollStage>
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
    <DieVisual
      position={inside ? [0, 0.62, WARMUP_CENTER_Z] : [1.86, 0, WARMUP_CENTER_Z]}
      size={DIE_GEOMETRY.size}
      resources={resources}
    />
  );
}
