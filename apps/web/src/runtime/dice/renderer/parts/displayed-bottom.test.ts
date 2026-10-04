import {
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  Quaternion,
  Vector2,
  Vector3,
} from 'three';
import { describe, expect, test } from 'vitest';

import { displayedBottomDepth } from '@/runtime/dice/renderer/parts/displayed-bottom.test-support';

const square = [new Vector2(-1, -1), new Vector2(1, -1), new Vector2(1, 1), new Vector2(-1, 1)];
const identity = new Matrix4();

function triangle(vertices: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(vertices, 3));
  return geometry;
}

describe('displayed bottom surface diagnostic', () => {
  test.each([
    { name: 'inner indentation hidden within the base', y: -1.02, depth: 0 },
    { name: 'a separated surface above the inner floor', y: -0.9, depth: 0 },
    { name: 'known external underside crossing', y: -1.12, depth: 0.04 },
  ])('$name', ({ y, depth }) => {
    const geometry = triangle([-0.2, y, -0.2, 0.2, y, -0.2, 0, y, 0.2]);
    try {
      expect(displayedBottomDepth(geometry, identity, identity, square, -1.08)).toBeCloseTo(
        depth,
        6,
      );
    } finally {
      geometry.dispose();
    }
  });

  test('excludes a die below the plane but outside the finite footprint', () => {
    const geometry = triangle([3, -2, 3, 4, -2, 3, 3, -2, 4]);
    try {
      expect(displayedBottomDepth(geometry, identity, identity, square, -1.08)).toBe(0);
    } finally {
      geometry.dispose();
    }
  });

  test.each([
    { winding: 'counterclockwise', footprint: square },
    { winding: 'clockwise', footprint: [...square].reverse() },
  ])(
    'clips a $winding slanted triangle whose original vertices are all outside',
    ({ footprint }) => {
      // At z=-1 the interpolated edge lies at y=-1.105: 0.025 below the underside.
      const geometry = triangle([-2, -1.18, -2, 2, -1.18, -2, 0, -0.88, 2]);
      try {
        expect(displayedBottomDepth(geometry, identity, identity, footprint, -1.08)).toBeCloseTo(
          0.025,
          6,
        );
      } finally {
        geometry.dispose();
      }
    },
  );

  test('uses the actual inverse for rotated, slightly non-unit endpoint quaternions', () => {
    const geometry = triangle([-0.2, -1.12, -0.2, 0.2, -1.12, -0.2, 0, -1.12, 0.2]);
    const matrix = new Matrix4().compose(
      new Vector3(3, 4, 5),
      new Quaternion(0.1351, -0.2294, 0.3105, 0.9136),
      new Vector3(1, 1, 1),
    );
    try {
      expect(displayedBottomDepth(geometry, matrix, matrix, square, -1.08)).toBeCloseTo(0.04, 6);
    } finally {
      geometry.dispose();
    }
  });
});
