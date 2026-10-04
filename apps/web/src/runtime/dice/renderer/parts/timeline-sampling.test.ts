import type { CupMotion, DieFrame } from '@repo/dice-simulation/contract';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  cupExitOpacityAt,
  sampleCupFrames,
  sampleDieFrames,
} from '@/runtime/dice/renderer/parts/timeline-sampling';

describe('dice timeline sampling', () => {
  const frames: readonly DieFrame[] = [
    { t: 100, p: [0, 2, 0], q: [0, 0, 0, 1] },
    { t: 300, p: [2, 0, 4], q: [0, 0, 1, 0] },
  ];

  it('hides missing or not-yet-started timelines and holds endpoint poses', () => {
    expect(sampleDieFrames([], 0)).toMatchObject({ visible: false, p: [0, 0, 0], q: [0, 0, 0, 1] });
    expect(sampleDieFrames(frames, -1).visible).toBe(false);
    expect(sampleDieFrames(frames, 0)).toMatchObject({
      visible: true,
      p: frames[0].p,
      q: frames[0].q,
    });
    expect(sampleDieFrames(frames, 100)).toMatchObject({
      visible: true,
      p: frames[0].p,
      q: frames[0].q,
    });
    expect(sampleDieFrames(frames, 300)).toMatchObject({
      visible: true,
      p: frames[1].p,
      q: frames[1].q,
    });
    expect(sampleDieFrames(frames, 400)).toMatchObject({
      visible: true,
      p: frames[1].p,
      q: frames[1].q,
    });
  });

  it('interpolates position and spherical rotation between physical poses', () => {
    const sample = sampleDieFrames(frames, 200);
    expect(sample.visible).toBe(true);
    expect(sample.p).toEqual([1, 1, 2]);
    expect(sample.q[0]).toBe(0);
    expect(sample.q[1]).toBe(0);
    expect(sample.q[2]).toBeCloseTo(Math.SQRT1_2);
    expect(sample.q[3]).toBeCloseTo(Math.SQRT1_2);
  });
});

const pourCup: CupMotion = {
  style: 'classic',
  shakeAmplitude: 1,
  shakeFrequency: 24,
  pourAtMs: 100,
  releaseAtMs: 500,
  exitAtMs: 960,
  innerWidth: 2.48,
  innerDepth: 1.64,
  innerHeight: 1.1,
  frames: [cupFrame(100, 0), cupFrame(300, 0.75), cupFrame(500, 1)],
};

describe('cup pour presentation', () => {
  it('preserves the physical cup pose at a keyframe', () => {
    const visual = sampleCupFrames(pourCup.frames, 300);
    const physical = pourCup.frames[1];

    expect(visual.p).toEqual([0, 1, 0]);
    expect(visual.q).toEqual(physical.q);
  });
});

describe('cup timeline sampling', () => {
  const frames: CupMotion['frames'] = [
    { t: 100, p: [0, 2, 0], q: [0, 0, 0, 1], visible: false, mode: 'pour' },
    { t: 300, p: [2, 0, 4], q: [0, 0, 1, 0], visible: true, mode: 'exit' },
    { t: 500, p: [4, 2, 0], q: [0, 0, 0, 1], visible: false, mode: 'exit' },
    { t: 700, p: [6, 0, 4], q: [0, 0, 1, 0], visible: false, mode: 'exit' },
  ];

  it('interpolates interior poses and keeps visibility across either visible boundary', () => {
    const sample = sampleCupFrames(frames, 200);
    expect(sample.p).toEqual([1, 1, 2]);
    expect(sample.q[0]).toBe(0);
    expect(sample.q[1]).toBe(0);
    expect(sample.q[2]).toBeCloseTo(Math.SQRT1_2);
    expect(sample.q[3]).toBeCloseTo(Math.SQRT1_2);
    expect(sample.visible).toBe(true);
    expect(sampleCupFrames(frames, 400).p).toEqual([3, 1, 2]);
    expect(sampleCupFrames(frames, 400).visible).toBe(true);
    expect(sampleCupFrames(frames, 500).visible).toBe(true);
    expect(sampleCupFrames(frames, 501).visible).toBe(false);
    expect(sampleCupFrames(frames, 600).visible).toBe(false);
  });

  it('preserves endpoint poses and the empty cup default', () => {
    expect(sampleCupFrames(frames, -1)).toEqual(frames[0]);
    expect(sampleCupFrames(frames, 100)).toEqual(frames[0]);
    expect(sampleCupFrames(frames, 700)).toEqual(frames[3]);
    expect(sampleCupFrames(frames, 701)).toEqual(frames[3]);
    expect(sampleCupFrames([], 0)).toEqual({
      visible: true,
      p: [1.2, 1.62, -0.08],
      q: [0, 0, 0, 1],
    });
  });
});

describe('cup exit presentation', () => {
  it('holds the cup through release and fades it continuously before exit', () => {
    const releaseAtMs = 1000;
    const exitAtMs = 1800;

    expect(cupExitOpacityAt(1000, releaseAtMs, exitAtMs)).toBe(1);
    expect(cupExitOpacityAt(1440, releaseAtMs, exitAtMs)).toBe(1);
    expect(cupExitOpacityAt(1580, releaseAtMs, exitAtMs)).toBeGreaterThan(0);
    expect(cupExitOpacityAt(1580, releaseAtMs, exitAtMs)).toBeLessThan(1);
    expect(cupExitOpacityAt(1790, releaseAtMs, exitAtMs)).toBeGreaterThan(0);
    expect(cupExitOpacityAt(1800, releaseAtMs, exitAtMs)).toBe(0);
  });
});

function cupFrame(t: number, tilt: number): CupMotion['frames'][number] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt);
  return {
    t,
    p: [0, 1, 0],
    q: [q.x, q.y, q.z, q.w],
    visible: true,
    mode: t < 500 ? 'pour' : 'exit',
  };
}
