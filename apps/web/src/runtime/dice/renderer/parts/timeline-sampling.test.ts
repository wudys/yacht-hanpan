import type { CupMotion, DieFrame } from '@repo/dice-simulation/contract';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import {
  createCupFrameSampler,
  createDieFrameSampler,
  cupExitOpacityAt,
} from '@/runtime/dice/renderer/parts/timeline-sampling';

describe('dice timeline sampling', () => {
  const frames: readonly DieFrame[] = [
    { t: 100, p: [0, 2, 0], q: [0, 0, 0, 1] },
    { t: 300, p: [2, 0, 4], q: [0, 0, 1, 0] },
  ];

  it('hides missing or not-yet-started timelines and holds endpoint poses', () => {
    expect(createDieFrameSampler([])(0)).toMatchObject({
      visible: false,
      p: [0, 0, 0],
      q: [0, 0, 0, 1],
    });
    expect(createDieFrameSampler(frames)(-1).visible).toBe(false);
    expect(createDieFrameSampler(frames)(0)).toMatchObject({
      visible: true,
      p: frames[0].p,
      q: frames[0].q,
    });
    expect(createDieFrameSampler(frames)(100)).toMatchObject({
      visible: true,
      p: frames[0].p,
      q: frames[0].q,
    });
    expect(createDieFrameSampler(frames)(300)).toMatchObject({
      visible: true,
      p: frames[1].p,
      q: frames[1].q,
    });
    expect(createDieFrameSampler(frames)(400)).toMatchObject({
      visible: true,
      p: frames[1].p,
      q: frames[1].q,
    });
  });

  it('interpolates position and spherical rotation between physical poses', () => {
    const sample = createDieFrameSampler(frames)(200);
    expect(sample.visible).toBe(true);
    expect(sample.p).toEqual([1, 1, 2]);
    expect(sample.q[0]).toBe(0);
    expect(sample.q[1]).toBe(0);
    expect(sample.q[2]).toBeCloseTo(Math.SQRT1_2);
    expect(sample.q[3]).toBeCloseTo(Math.SQRT1_2);
  });

  it('seeks in either direction and restores the hidden pose after playback', () => {
    const sample = createDieFrameSampler(frames);
    expect([...sample(250).p]).toEqual([1.5, 0.5, 3]);
    expect([...sample(150).p]).toEqual([0.5, 1.5, 1]);
    expect([...sample(400).p]).toEqual(frames[1].p);
    expect(sample(-1)).toEqual({ visible: false, p: [0, 0, 0], q: [0, 0, 0, 1] });
    expect([...sample(200).p]).toEqual([1, 1, 2]);
  });

  it('copies single-frame poses without normalizing endpoint rotations', () => {
    const frame: DieFrame = { t: 100, p: [1, 2, 3], q: [0.1351, -0.2294, 0.3105, 0.9136] };
    const sample = createDieFrameSampler([frame]);
    for (const timeMs of [0, 100, 200]) {
      expect(sample(timeMs)).toEqual({ visible: true, p: frame.p, q: frame.q });
    }
  });

  it('owns independent scratch and never aliases or mutates source poses', () => {
    const frozen = frames.map((frame) =>
      Object.freeze({
        ...frame,
        p: Object.freeze([...frame.p]) as unknown as DieFrame['p'],
        q: Object.freeze([...frame.q]) as unknown as DieFrame['q'],
      }),
    );
    const first = createDieFrameSampler(Object.freeze(frozen));
    const second = createDieFrameSampler(frozen);
    const retained = first(200);
    const retainedPosition = retained.p;
    const retainedRotation = retained.q;
    second(250);
    expect(retained.p).toEqual([1, 1, 2]);
    expect(first(100)).toBe(retained);
    expect(retained.p).toBe(retainedPosition);
    expect(retained.q).toBe(retainedRotation);
    expect(retained.p).not.toBe(frozen[0].p);
    expect(retained.q).not.toBe(frozen[0].q);
    retained.p[0] = 99;
    retained.q[0] = 99;
    expect(frozen[0]).toEqual(frames[0]);
    expect(first(200).p).toEqual([1, 1, 2]);
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
    const visual = createCupFrameSampler(pourCup.frames)(300);
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
    const sample = createCupFrameSampler(frames)(200);
    expect(sample.p).toEqual([1, 1, 2]);
    expect(sample.q[0]).toBe(0);
    expect(sample.q[1]).toBe(0);
    expect(sample.q[2]).toBeCloseTo(Math.SQRT1_2);
    expect(sample.q[3]).toBeCloseTo(Math.SQRT1_2);
    expect(sample.visible).toBe(true);
    expect(createCupFrameSampler(frames)(400).p).toEqual([3, 1, 2]);
    expect(createCupFrameSampler(frames)(400).visible).toBe(true);
    expect(createCupFrameSampler(frames)(500).visible).toBe(true);
    expect(createCupFrameSampler(frames)(501).visible).toBe(false);
    expect(createCupFrameSampler(frames)(600).visible).toBe(false);
  });

  it('preserves endpoint poses and the empty cup default', () => {
    expect(createCupFrameSampler(frames)(-1)).toEqual({
      visible: frames[0].visible,
      p: frames[0].p,
      q: frames[0].q,
    });
    expect(createCupFrameSampler(frames)(100)).toEqual({
      visible: frames[0].visible,
      p: frames[0].p,
      q: frames[0].q,
    });
    expect(createCupFrameSampler(frames)(700)).toEqual({
      visible: frames[3].visible,
      p: frames[3].p,
      q: frames[3].q,
    });
    expect(createCupFrameSampler(frames)(701)).toEqual({
      visible: frames[3].visible,
      p: frames[3].p,
      q: frames[3].q,
    });
    expect(createCupFrameSampler([])(0)).toEqual({
      visible: true,
      p: [1.2, 1.62, -0.08],
      q: [0, 0, 0, 1],
    });
  });

  it('keeps interior exact-key visibility left-biased across backward seeks', () => {
    const sample = createCupFrameSampler(frames);
    for (const time of [501, 700, 500, 200, 500]) {
      expect(sample(time).visible).toBe(time <= 500);
    }
    expect(sample(100).visible).toBe(false);
    expect(sample(700).visible).toBe(false);
    const single = createCupFrameSampler([frames[0]]);
    for (const time of [-1, 100, 701]) {
      expect(single(time)).toEqual({ visible: false, p: frames[0].p, q: frames[0].q });
    }
  });

  it('does not share cup results with dice or another cup sampler', () => {
    const cup = createCupFrameSampler(frames);
    const otherCup = createCupFrameSampler(frames);
    const die = createDieFrameSampler(frames);
    const retained = cup(200);
    otherCup(600);
    die(300);
    expect(retained.visible).toBe(true);
    expect(retained.p).toEqual([1, 1, 2]);
    expect(cup(700)).toBe(retained);
    expect(retained.p).not.toBe(frames[3].p);
    expect(retained.q).not.toBe(frames[3].q);
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
