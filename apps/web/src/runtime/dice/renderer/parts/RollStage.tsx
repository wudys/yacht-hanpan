import { useThree } from '@react-three/fiber';
import { type RollArea, TRAY_FLOOR_TOP_Y, TRAY_GEOMETRY } from '@repo/dice-simulation/contract';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

import { computeRollFit, type RollStageLayout } from '@/runtime/dice/game-dice-layout';

interface RollStageProps {
  rollArea: RollArea;
  layout?: RollStageLayout;
  children: ReactNode;
}

const DEFAULT_LAYOUT: RollStageLayout = {
  layerPadding: { extraX: 16, extraTop: 0, extraBottom: 8 },
  visualInset: { x: 18, y: 18 },
};

const ROLL_CAMERA_HEIGHT = 7.48;
const SHADOW_RECEIVER_EXTENSION = { x: 0.18, top: 0.42 };

export function RollStage({ rollArea, layout = DEFAULT_LAYOUT, children }: RollStageProps) {
  return (
    <>
      <RollCamera rollArea={rollArea} layout={layout} />
      <ambientLight intensity={1.18} />
      <hemisphereLight args={['#fff8ea', '#1c302a', 0.22]} />
      <RollKeyLight rollArea={rollArea} layout={layout} />
      <RollFloor rollArea={rollArea} layout={layout} />
      {children}
    </>
  );
}

function RollKeyLight({ rollArea, layout }: { rollArea: RollArea; layout: RollStageLayout }) {
  const { size } = useThree();
  const lightRef = useRef<THREE.DirectionalLight>(null);
  const targetRef = useRef<THREE.Object3D>(null);
  const centerZ = rollArea.centerZ ?? 1.23;

  useLayoutEffect(() => {
    if (!lightRef.current || !targetRef.current) return;
    const light = lightRef.current;
    light.target = targetRef.current;
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    light.shadow.updateMatrices(light);
    const fit = computeRollFit({
      ...layout,
      rollArea,
      size,
    });
    const receiver = computeShadowReceiverArea(rollArea, fit.worldPerPixel, layout.visualInset);
    // Fit the whole stable scene volume, not the cup's changing per-frame pose.
    // Light-space axes differ from screen axes; fixed screen-like bounds clip pours.
    const { camera } = light.shadow;
    const bounds = new THREE.Box3();
    for (const x of [-receiver.width / 2, receiver.width / 2]) {
      for (const y of [
        TRAY_FLOOR_TOP_Y - 0.004,
        TRAY_GEOMETRY.ceilingY - TRAY_GEOMETRY.ceilingHalfHeight,
      ]) {
        for (const z of [
          receiver.centerZ - receiver.depth / 2,
          receiver.centerZ + receiver.depth / 2,
        ]) {
          bounds.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse));
        }
      }
    }
    const margin = 0.15;
    camera.left = bounds.min.x - margin;
    camera.right = bounds.max.x + margin;
    camera.bottom = bounds.min.y - margin;
    camera.top = bounds.max.y + margin;
    camera.near = Math.max(0.1, -bounds.max.z - margin);
    camera.far = -bounds.min.z + margin;
    camera.updateProjectionMatrix();
  }, [centerZ, layout, rollArea, size]);

  return (
    <>
      <object3D ref={targetRef} position={[0, TRAY_GEOMETRY.floorY, centerZ]} />
      <directionalLight
        ref={lightRef}
        position={[1.25, 8.1, centerZ]}
        intensity={2.12}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-bias={-0.0002}
        shadow-normalBias={0.015}
        shadow-radius={4}
        shadow-intensity={0.6}
      />
    </>
  );
}

function RollCamera({ rollArea, layout }: { rollArea: RollArea; layout: RollStageLayout }) {
  const { camera, size } = useThree();

  useLayoutEffect(() => {
    if (!(camera instanceof THREE.OrthographicCamera)) return;

    const fit = computeRollFit({
      layerPadding: layout.layerPadding,
      rollArea,
      size,
      visualInset: layout.visualInset,
    });

    camera.position.set(0, ROLL_CAMERA_HEIGHT, fit.cameraCenterZ);
    camera.rotation.set(-Math.PI / 2, 0, 0);
    camera.zoom = 1 / fit.worldPerPixel;
    camera.near = 0.1;
    camera.far = 20;
    camera.updateProjectionMatrix();
  }, [camera, rollArea, size, layout]);

  return null;
}

function RollFloor({ rollArea, layout }: { rollArea: RollArea; layout: RollStageLayout }) {
  const { size } = useThree();
  const fit = computeRollFit({
    layerPadding: layout.layerPadding,
    rollArea,
    size,
    visualInset: layout.visualInset,
  });
  const receiver = computeShadowReceiverArea(rollArea, fit.worldPerPixel, layout.visualInset);
  const geometry = useMemo(
    () => new THREE.ShapeGeometry(roundedRectShape(receiver.width, receiver.depth, 0.16), 12),
    [receiver.depth, receiver.width],
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <mesh
      geometry={geometry}
      position={[0, TRAY_FLOOR_TOP_Y - 0.004, receiver.centerZ]}
      rotation={[-Math.PI / 2, 0, 0]}
      receiveShadow
      renderOrder={-4}
    >
      {/* Preserve the floor's 0.18 full-shadow alpha while softening surface shadows. */}
      <shadowMaterial transparent opacity={0.3} depthWrite={false} />
    </mesh>
  );
}

function computeShadowReceiverArea(
  rollArea: RollArea,
  worldPerPixel: number,
  visualInset: RollStageLayout['visualInset'],
) {
  const receiverInsetX = visualInset.x * worldPerPixel;
  const receiverInsetY = visualInset.y * worldPerPixel;
  return {
    width: rollArea.width + receiverInsetX * 2 + SHADOW_RECEIVER_EXTENSION.x * 2,
    depth: rollArea.depth + receiverInsetY * 2 + SHADOW_RECEIVER_EXTENSION.top,
    centerZ: (rollArea.centerZ ?? 1.23) - SHADOW_RECEIVER_EXTENSION.top / 2,
  };
}

function roundedRectShape(width: number, depth: number, radius: number) {
  const halfWidth = width / 2;
  const halfDepth = depth / 2;
  const r = Math.min(radius, halfWidth, halfDepth);
  const shape = new THREE.Shape();

  shape.moveTo(-halfWidth + r, -halfDepth);
  shape.lineTo(halfWidth - r, -halfDepth);
  shape.quadraticCurveTo(halfWidth, -halfDepth, halfWidth, -halfDepth + r);
  shape.lineTo(halfWidth, halfDepth - r);
  shape.quadraticCurveTo(halfWidth, halfDepth, halfWidth - r, halfDepth);
  shape.lineTo(-halfWidth + r, halfDepth);
  shape.quadraticCurveTo(-halfWidth, halfDepth, -halfWidth, halfDepth - r);
  shape.lineTo(-halfWidth, -halfDepth + r);
  shape.quadraticCurveTo(-halfWidth, -halfDepth, -halfWidth + r, -halfDepth);

  return shape;
}
