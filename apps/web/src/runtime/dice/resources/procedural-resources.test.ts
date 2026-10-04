import { BufferGeometry, MeshStandardMaterial, Texture } from 'three';
import { expect, test, vi } from 'vitest';

import type { CanvasFactory } from '@/runtime/dice/resources/canvas-factory';
import { createProceduralDiceResources } from '@/runtime/dice/resources/procedural-resources';

test('paints each material texture with the pips for its physics face normal', () => {
  const pips = new Map<unknown, number>();
  const createCanvas = ((width: number, height: number) => {
    const canvas = {
      width,
      height,
      getContext: () => ({
        fillStyle: '',
        fillRect() {},
        beginPath() {},
        arc() {
          pips.set(canvas, (pips.get(canvas) ?? 0) + 1);
        },
        fill() {},
      }),
    };
    return canvas;
  }) as unknown as CanvasFactory;
  const resources = createProceduralDiceResources(createCanvas);
  try {
    // BoxGeometry groups are +X, -X, +Y, -Y, +Z, -Z.
    expect(resources.dieMaterials.map((material) => pips.get(material.map!.image))).toEqual([
      3, 4, 1, 6, 2, 5,
    ]);
  } finally {
    resources.dispose();
  }
});

test('owns die and cup geometry and textures until disposed once', () => {
  const createCanvas = ((width: number, height: number) => ({
    width,
    height,
    getContext: () => ({ fillStyle: '', fillRect() {}, beginPath() {}, arc() {}, fill() {} }),
  })) as unknown as CanvasFactory;
  const resources = createProceduralDiceResources(createCanvas);
  expect(resources.dieMaterials).toHaveLength(6);
  expect(
    resources.dieMaterials.every(
      (material) => material.clippingPlanes === null && !material.clipShadows,
    ),
  ).toBe(true);
  const owned = [
    resources.dieGeometry,
    ...resources.dieMaterials,
    ...resources.dieMaterials.map((material) => material.map!),
    ...Object.values(resources.cup.geometry),
    resources.cup.texture,
  ];
  const counts = owned.map(() => 0);
  owned.forEach((resource, index) =>
    resource.addEventListener('dispose', () => {
      counts[index]! += 1;
    }),
  );
  resources.dispose();
  resources.dispose();
  expect(counts).toEqual(owned.map(() => 1));
});

test.each([
  { failedCanvas: 3, geometries: 0, materials: 2 },
  { failedCanvas: 7, geometries: 1, materials: 6 },
])(
  'releases partial resources when canvas $failedCanvas fails, then allows retry',
  ({ failedCanvas, geometries, materials }) => {
    const geometryDisposed = vi.spyOn(BufferGeometry.prototype, 'dispose');
    const materialDisposed = vi.spyOn(MeshStandardMaterial.prototype, 'dispose');
    const textureDisposed = vi.spyOn(Texture.prototype, 'dispose');
    let canvases = 0;
    const createCanvas = ((width: number, height: number) => {
      canvases += 1;
      if (canvases === failedCanvas) throw new Error('Canvas unavailable');
      return {
        width,
        height,
        getContext: () => ({ fillStyle: '', fillRect() {}, beginPath() {}, arc() {}, fill() {} }),
      };
    }) as unknown as CanvasFactory;
    try {
      expect(() => createProceduralDiceResources(createCanvas)).toThrow('Canvas unavailable');
      expect(geometryDisposed).toHaveBeenCalledTimes(geometries);
      expect(materialDisposed).toHaveBeenCalledTimes(materials);
      expect(textureDisposed).toHaveBeenCalledTimes(materials);
      const retry = createProceduralDiceResources(createCanvas);
      expect(retry.cup.texture).toBeInstanceOf(Texture);
      retry.dispose();
    } finally {
      geometryDisposed.mockRestore();
      materialDisposed.mockRestore();
      textureDisposed.mockRestore();
    }
  },
);
