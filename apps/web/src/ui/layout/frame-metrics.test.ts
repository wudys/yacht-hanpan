import { describe, expect, test } from 'vitest';

import {
  BASE_FRAME_WIDTH,
  computeFrameMetrics,
  computeLogoPlacement,
  DESKTOP_MAX_SCALE,
  isUnsupportedCoarseLandscape,
  MOBILE_MAX_WIDTH,
} from '@/ui/layout/frame-metrics';

describe('computeFrameMetrics', () => {
  test.each([
    [320, 568, 0.888889, 320, 444.444, 0],
    [360, 500, 1, 360, 500, 0],
    [360, 640, 1, 360, 500, 0],
    [390, 844, 1.083333, 390, 541.667, 0],
    [430, 932, 1.194444, 430, 597.222, 0],
    [431, 932, 1.197222, 431, 598.611, 0],
    [390, 480, 0.96, 345.6, 480, 22.2],
    [430, 500, 1, 360, 500, 35],
    [1024, 600, 1.2, 432, 600, 296],
  ])(
    '%sx%s keeps the 360x500 canvas uniform and top-centered',
    (width, height, scale, frameWidth, frameHeight, x) => {
      const metrics = computeFrameMetrics({ width, height });
      expect(metrics.scale).toBeCloseTo(scale, 5);
      expect(metrics.frame.width).toBeCloseTo(frameWidth, 2);
      expect(metrics.frame.height).toBeCloseTo(frameHeight, 2);
      expect(metrics.frame.x).toBeCloseTo(x, 2);
      expect(metrics.frame.y).toBe(0);
      expect(metrics.frame.width / metrics.frame.height).toBeCloseTo(18 / 25, 8);
    },
  );

  test('uses the exact 430px mobile boundary and 640px desktop cap', () => {
    expect(computeFrameMetrics({ width: 430, height: 1000 }).mode).toBe('mobile');
    expect(computeFrameMetrics({ width: 431, height: 1000 }).mode).toBe('desktop');
    expect(computeFrameMetrics({ width: 2560, height: 1440 }).scale).toBe(DESKTOP_MAX_SCALE);
    expect(MOBILE_MAX_WIDTH).toBe(430);
    expect(DESKTOP_MAX_SCALE).toBe(16 / 9);
  });

  test.each([
    [1366, 768, 552.96, 768, 406.52],
    [1536, 1024, 640, 500 * (16 / 9), 448],
    [1920, 950, 640, 500 * (16 / 9), 640],
    [1920, 900, 640, 500 * (16 / 9), 640],
    [1920, 850, 612, 850, 654],
  ])(
    '%sx%s applies the desktop cap or actual viewport height',
    (width, height, frameWidth, frameHeight, x) => {
      const metrics = computeFrameMetrics({ width, height });
      expect(metrics.frame.width).toBeCloseTo(frameWidth, 3);
      expect(metrics.frame.height).toBeCloseTo(frameHeight, 3);
      expect(metrics.frame.x).toBeCloseTo(x, 3);
      expect(metrics.frame.y).toBe(0);
    },
  );

  test('subtracts safe-area before fitting and keeps physical origin inside it', () => {
    const metrics = computeFrameMetrics({
      width: 390,
      height: 844,
      safeArea: { top: 47, right: 0, bottom: 34, left: 0 },
    });
    expect(metrics.content).toEqual({ x: 0, y: 47, width: 390, height: 763 });
    expect(metrics.scale).toBeCloseTo(390 / BASE_FRAME_WIDTH, 6);
    expect(metrics.frame.y).toBe(47);
  });

  test('keeps the same best-effort formula below the supported floor', () => {
    const metrics = computeFrameMetrics({ width: 280, height: 300 });
    expect(metrics.scale).toBe(0.6);
    expect(metrics.frame).toMatchObject({ width: 216, height: 300, y: 0 });
  });
});

describe('wrapper-owned layout decisions', () => {
  test('shows a bottom-right logo only when it fits and does not overlap the frame', () => {
    const metrics = computeFrameMetrics({ width: 1000, height: 700 });
    expect(
      computeLogoPlacement(metrics, { width: 80, height: 32, edge: 16, clearance: 12 }),
    ).toMatchObject({ visible: true });

    const mobile = computeFrameMetrics({ width: 390, height: 600 });
    expect(
      computeLogoPlacement(mobile, { width: 80, height: 32, edge: 16, clearance: 12 }),
    ).toEqual({ visible: false, x: 0, y: 0 });
  });

  test('coarse landscape blocks before breakpoint classification', () => {
    expect(isUnsupportedCoarseLandscape({ width: 844, height: 390, coarsePointer: true })).toBe(
      true,
    );
    expect(isUnsupportedCoarseLandscape({ width: 844, height: 390, coarsePointer: false })).toBe(
      false,
    );
  });
});
