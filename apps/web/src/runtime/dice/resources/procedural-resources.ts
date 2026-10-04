import { DIE_GEOMETRY } from '@repo/dice-simulation/contract';
import {
  CanvasTexture,
  LinearFilter,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Texture,
} from 'three';
// Three.js publishes addon entry points with the explicit .js extension.
// eslint-disable-next-line import-x/extensions
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

import { type CanvasFactory, defaultCanvasFactory } from '@/runtime/dice/resources/canvas-factory';
import { createCupResources, type CupResources } from '@/runtime/dice/resources/cup-resources';

export type ProceduralDiceResources = Readonly<{
  cup: CupResources;
  dieGeometry: RoundedBoxGeometry;
  dieMaterials: readonly MeshStandardMaterial[];
  dispose(): void;
}>;

/** Three BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z. */
const DIE_MATERIAL_FACE_ORDER = [3, 4, 1, 6, 2, 5] as const;

const PIPS_BY_FACE: Readonly<Record<number, readonly [number, number][]>> = {
  1: [[0.5, 0.5]],
  2: [
    [0.3, 0.3],
    [0.7, 0.7],
  ],
  3: [
    [0.3, 0.3],
    [0.5, 0.5],
    [0.7, 0.7],
  ],
  4: [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.3, 0.7],
    [0.7, 0.7],
  ],
  5: [
    [0.3, 0.3],
    [0.7, 0.3],
    [0.5, 0.5],
    [0.3, 0.7],
    [0.7, 0.7],
  ],
  6: [
    [0.3, 0.25],
    [0.7, 0.25],
    [0.3, 0.5],
    [0.7, 0.5],
    [0.3, 0.75],
    [0.7, 0.75],
  ],
};

function dieFaceTexture(face: number, createCanvas: CanvasFactory): CanvasTexture {
  const size = 128;
  const canvas = createCanvas(size, size);
  const context = canvas.getContext('2d');
  if (!context || !('fillStyle' in context)) throw new Error('2D Canvas context is unavailable');
  context.fillStyle = '#fffaf0';
  context.fillRect(0, 0, size, size);
  context.fillStyle = '#10221d';
  for (const [x, y] of PIPS_BY_FACE[face] ?? []) {
    context.beginPath();
    context.arc(x * size, y * size, size / 12, 0, Math.PI * 2);
    context.fill();
  }
  const texture = new CanvasTexture(canvas as HTMLCanvasElement);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function createDieMaterials(
  createCanvas: CanvasFactory = defaultCanvasFactory,
): MeshStandardMaterial[] {
  const materials: MeshStandardMaterial[] = [];
  try {
    for (const face of DIE_MATERIAL_FACE_ORDER) {
      materials.push(
        new MeshStandardMaterial({
          map: dieFaceTexture(face, createCanvas),
          roughness: 0.72,
          metalness: 0,
        }),
      );
    }
    return materials;
  } catch (error) {
    for (const material of materials) {
      material.map?.dispose();
      material.dispose();
    }
    throw error;
  }
}

export function createProceduralDiceResources(
  createCanvas: CanvasFactory = defaultCanvasFactory,
): ProceduralDiceResources {
  const dieMaterials = createDieMaterials(createCanvas);
  const textures: Texture[] = dieMaterials.flatMap((material) =>
    material.map ? [material.map] : [],
  );
  const dieGeometry = new RoundedBoxGeometry(
    1,
    1,
    1,
    5,
    DIE_GEOMETRY.colliderRadius / DIE_GEOMETRY.size,
  );
  let cup: CupResources;
  try {
    cup = createCupResources(createCanvas);
  } catch (error) {
    dieGeometry.dispose();
    for (const material of dieMaterials) material.dispose();
    for (const texture of textures) texture.dispose();
    throw error;
  }
  let disposed: boolean = false;

  return {
    cup,
    dieGeometry,
    dieMaterials,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const geometry of Object.values(cup.geometry)) geometry.dispose();
      cup.texture.dispose();
      dieGeometry.dispose();
      for (const material of dieMaterials) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
}
