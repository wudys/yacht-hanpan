import { CUP_EXIT_HOLD_MS, type CupMotion, type DieFrame } from '@repo/dice-simulation/contract';
import * as THREE from 'three';

export interface TimelineSample {
  visible: boolean;
  p: [number, number, number];
  q: [number, number, number, number];
}

/** Each call overwrites this sampler's result; consumers copy it before sampling again. */
export function createDieFrameSampler(frames: readonly DieFrame[]) {
  const { sample, interpolate } = createPoseSampler(frames);
  return (timeMs: number): TimelineSample => {
    if (frames.length === 0 || timeMs < 0) {
      sample.visible = false;
      sample.p[0] = sample.p[1] = sample.p[2] = 0;
      sample.q[0] = sample.q[1] = sample.q[2] = 0;
      sample.q[3] = 1;
    } else if (timeMs <= frames[0].t) {
      copyPose(sample, frames[0], true);
    } else if (timeMs >= frames[frames.length - 1].t) {
      copyPose(sample, frames[frames.length - 1], true);
    } else {
      interpolate(timeMs);
      sample.visible = true;
    }
    return sample;
  };
}

/** The mutable result and interpolation scratch belong only to this sampler. */
export function createCupFrameSampler(frames: CupMotion['frames']) {
  const { sample, interpolate } = createPoseSampler(frames);
  if (frames.length === 0) {
    sample.visible = true;
    sample.p[0] = 1.2;
    sample.p[1] = 1.62;
    sample.p[2] = -0.08;
  }
  return (timeMs: number): TimelineSample => {
    if (frames.length === 0) return sample;
    if (timeMs <= frames[0].t) {
      copyPose(sample, frames[0], frames[0].visible);
    } else if (timeMs >= frames[frames.length - 1].t) {
      const last = frames[frames.length - 1];
      copyPose(sample, last, last.visible);
    } else {
      const index = interpolate(timeMs);
      sample.visible = frames[index - 1].visible || frames[index].visible;
    }
    return sample;
  };
}

function upperFrameIndex(frames: readonly DieFrame[], timeMs: number): number {
  // The first frame at or after timeMs keeps exact interior keys left-biased.
  let low = 1;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (frames[middle].t < timeMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function createPoseSampler(frames: readonly DieFrame[]) {
  const sample: TimelineSample = { visible: false, p: [0, 0, 0], q: [0, 0, 0, 1] };
  const fromPosition = new THREE.Vector3();
  const toPosition = new THREE.Vector3();
  const fromQuat = new THREE.Quaternion();
  const toQuat = new THREE.Quaternion();
  return {
    sample,
    interpolate(timeMs: number) {
      const index = upperFrameIndex(frames, timeMs);
      const from = frames[index - 1];
      const to = frames[index];
      const alpha = (timeMs - from.t) / (to.t - from.t);
      fromPosition.set(from.p[0], from.p[1], from.p[2]);
      toPosition.set(to.p[0], to.p[1], to.p[2]);
      const position = fromPosition.lerp(toPosition, alpha);
      fromQuat.set(from.q[0], from.q[1], from.q[2], from.q[3]);
      toQuat.set(to.q[0], to.q[1], to.q[2], to.q[3]);
      fromQuat.slerp(toQuat, alpha);
      sample.p[0] = position.x;
      sample.p[1] = position.y;
      sample.p[2] = position.z;
      sample.q[0] = fromQuat.x;
      sample.q[1] = fromQuat.y;
      sample.q[2] = fromQuat.z;
      sample.q[3] = fromQuat.w;
      return index;
    },
  };
}

function copyPose(sample: TimelineSample, frame: DieFrame, visible: boolean) {
  sample.visible = visible;
  sample.p[0] = frame.p[0];
  sample.p[1] = frame.p[1];
  sample.p[2] = frame.p[2];
  sample.q[0] = frame.q[0];
  sample.q[1] = frame.q[1];
  sample.q[2] = frame.q[2];
  sample.q[3] = frame.q[3];
}

export function cupExitOpacityAt(timeMs: number, releaseAtMs: number, exitAtMs: number): number {
  const fadeStartMs = Math.min(exitAtMs, releaseAtMs + CUP_EXIT_HOLD_MS);
  const progress = clamp01((timeMs - fadeStartMs) / Math.max(1, exitAtMs - fadeStartMs));
  const smoothProgress = progress * progress * (3 - 2 * progress);
  return 1 - smoothProgress;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
