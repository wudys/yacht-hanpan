import { DEFAULT_CUP_GEOMETRY } from '@repo/dice-simulation/contract';
import * as THREE from 'three';

import type { CanvasFactory, CanvasLike } from '@/runtime/dice/resources/canvas-factory';

export type CupResources = Readonly<{
  geometry: ReturnType<typeof createCupShellGeometry>;
  texture: THREE.CanvasTexture<CanvasLike>;
}>;

export function createCupResources(createCanvas: CanvasFactory): CupResources {
  const texture = createCupInteriorTexture(createCanvas);
  return { texture, geometry: createCupShellGeometry() };
}

function createCupShellGeometry() {
  const s = DEFAULT_CUP_GEOMETRY;
  const outer = new THREE.CylinderGeometry(
    s.innerRadius + s.wallThickness,
    s.bottomRadius + s.wallThickness,
    s.innerHeight,
    s.segments,
    1,
    true,
  );
  const inner = new THREE.CylinderGeometry(
    s.innerRadius,
    s.bottomRadius,
    s.innerHeight,
    s.segments,
    1,
    true,
  );
  const base = new THREE.CylinderGeometry(
    s.bottomRadius + s.wallThickness,
    s.bottomRadius + s.wallThickness,
    s.baseThickness,
    s.segments,
  );
  const floor = new THREE.CircleGeometry(s.bottomRadius, s.segments);
  const rim = new THREE.RingGeometry(s.innerRadius, s.innerRadius + s.wallThickness, s.segments);
  return {
    outer,
    inner,
    base,
    floor,
    rim,
  };
}

function createCupInteriorTexture(createCanvas: CanvasFactory) {
  const canvas = createCanvas(256, 256);
  const context = canvas.getContext('2d');
  if (!context || !('fillStyle' in context)) throw new Error('2D Canvas context is unavailable');

  context.fillStyle = '#365f2f';
  context.fillRect(0, 0, 256, 256);

  for (let i = 0; i < 1400; i += 1) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const alpha = Math.random() * 0.022;
    context.fillStyle =
      Math.random() > 0.5 ? `rgba(255, 255, 255, ${alpha})` : `rgba(0, 0, 0, ${alpha})`;
    context.fillRect(x, y, 1, 1);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
