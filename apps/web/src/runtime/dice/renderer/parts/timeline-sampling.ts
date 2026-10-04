import { CUP_EXIT_HOLD_MS, type CupMotion, type DieFrame } from '@repo/dice-simulation/contract';
import * as THREE from 'three';

export interface TimelineSample {
  visible: boolean;
  p: [number, number, number];
  q: [number, number, number, number];
}

export function sampleDieFrames(frames: readonly DieFrame[], timeMs: number): TimelineSample {
  if (frames.length === 0 || timeMs < 0) {
    return {
      visible: false,
      p: [0, 0, 0],
      q: [0, 0, 0, 1],
    };
  }
  if (timeMs <= frames[0].t) return { visible: true, p: frames[0].p, q: frames[0].q };
  const last = frames[frames.length - 1];
  if (timeMs >= last.t) return { visible: true, p: last.p, q: last.q };

  const { p, q } = interpolatePose(frames, timeMs);
  return { visible: true, p, q };
}

export function sampleCupFrames(frames: CupMotion['frames'], timeMs: number) {
  if (frames.length === 0) {
    return {
      visible: true,
      p: [1.2, 1.62, -0.08] as [number, number, number],
      q: [0, 0, 0, 1] as [number, number, number, number],
    };
  }
  if (timeMs <= frames[0].t) return frames[0];
  const last = frames[frames.length - 1];
  if (timeMs >= last.t) return last;

  const { from, to, p, q } = interpolatePose(frames, timeMs);
  return { visible: from.visible || to.visible, p, q };
}

function interpolatePose<Frame extends DieFrame>(frames: readonly Frame[], timeMs: number) {
  let from = frames[0];
  let to = frames[1];
  for (let index = 0; index < frames.length - 1; index += 1) {
    if (timeMs >= frames[index].t && timeMs <= frames[index + 1].t) {
      from = frames[index];
      to = frames[index + 1];
      break;
    }
  }

  const alpha = (timeMs - from.t) / (to.t - from.t);
  const fromPosition = new THREE.Vector3(...from.p);
  const toPosition = new THREE.Vector3(...to.p);
  const position = fromPosition.lerp(toPosition, alpha);
  const fromQuat = new THREE.Quaternion(from.q[0], from.q[1], from.q[2], from.q[3]);
  const toQuat = new THREE.Quaternion(to.q[0], to.q[1], to.q[2], to.q[3]);
  fromQuat.slerp(toQuat, alpha);

  return {
    from,
    to,
    p: [position.x, position.y, position.z] as TimelineSample['p'],
    q: [fromQuat.x, fromQuat.y, fromQuat.z, fromQuat.w] as TimelineSample['q'],
  };
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
