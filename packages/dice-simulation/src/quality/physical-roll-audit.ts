import { type RollTimeline, TRAY_GEOMETRY } from '../contract';
import { recognizeTopFace, topFaceAlignment } from '../simulate/internal/result-recognition';
import { DIE_SIZE, FLOOR_TOP_Y } from '../simulate/internal/roll-simulation-constants';
import {
  REST_ANGULAR_SPEED,
  REST_LINEAR_SPEED,
} from '../simulate/internal/settling/settling-criteria';
import type { PhysicsCompletionSnapshot } from '../simulate/simulate-physics';

/** Offline quality measurements, not acceptance/rejection criteria for authoritative rolls. */
export function measurePhysicsCompletion(
  raw: PhysicsCompletionSnapshot,
  finalTimelineDice: RollTimeline['dice'],
) {
  const floor = FLOOR_TOP_Y + DIE_SIZE / 2;
  let rawStackedPairs = 0;
  let translatedDice = 0;
  let maxPlanarCorrectionDieWidths = 0;
  let maxAngularCorrectionRadians = 0;
  let facesPreserved = true;

  raw.dice.forEach((die, index) => {
    for (const other of raw.dice.slice(index + 1)) {
      const planar = Math.hypot(die.p[0] - other.p[0], die.p[2] - other.p[2]);
      const height = Math.abs(die.p[1] - other.p[1]);
      if (planar < DIE_SIZE * 1.02 && height > DIE_SIZE * 0.32) rawStackedPairs += 1;
    }
    const finalTimelineDie = finalTimelineDice.find((candidate) => candidate.slot === die.slot)!;
    const final = finalTimelineDie.frames.at(-1)!;
    const correction = Math.hypot(die.p[0] - final.p[0], die.p[2] - final.p[2]) / DIE_SIZE;
    if (correction > 0.01) translatedDice += 1;
    maxPlanarCorrectionDieWidths = Math.max(maxPlanarCorrectionDieWidths, correction);
    const dot = Math.abs(die.q.reduce((sum, value, i) => sum + value * final.q[i], 0));
    const normalizedDot = dot / (Math.hypot(...die.q) * Math.hypot(...final.q));
    maxAngularCorrectionRadians = Math.max(
      maxAngularCorrectionRadians,
      2 * Math.acos(Math.min(1, normalizedDot)),
    );
    facesPreserved &&=
      recognizeTopFace(die.q) === finalTimelineDie.value &&
      recognizeTopFace(final.q) === finalTimelineDie.value;
  });

  return {
    rawStackedPairs,
    rawOutsideTrayDice: raw.dice.filter(
      ({ p }) =>
        Math.abs(p[0]) > TRAY_GEOMETRY.halfWidth + 0.01 ||
        p[2] < TRAY_GEOMETRY.topZ - 0.01 ||
        p[2] > TRAY_GEOMETRY.bottomZ + 0.01 ||
        p[1] < FLOOR_TOP_Y - 0.01 ||
        p[1] > TRAY_GEOMETRY.ceilingY - TRAY_GEOMETRY.ceilingHalfHeight + 0.01,
    ).length,
    rawLiftedDice: raw.dice.filter((die) => die.p[1] - floor > DIE_SIZE * 0.32).length,
    rawLowReadabilityDice: raw.dice.filter((die) => topFaceAlignment(die.q) < 0.9).length,
    rawMaxLinearSpeed: Math.max(...raw.dice.map((die) => die.linearSpeed)),
    rawMaxAngularSpeed: Math.max(...raw.dice.map((die) => die.angularSpeed)),
    translatedDice,
    maxPlanarCorrectionDieWidths,
    maxAngularCorrectionRadians,
    facesPreserved,
  };
}

/**
 * Offline audit gate only; never used to reject or reroll a production outcome.
 * Speeds use the normal stability owner's strict bounds. Reading an unchanged
 * face does not make a moving or unsupported raw pose a settled result.
 */
export function physicsCompletionIssues(report: ReturnType<typeof measurePhysicsCompletion>) {
  const issues: string[] = [];
  if (!report.facesPreserved) issues.push('changed-faces');
  if (report.rawStackedPairs > 0) issues.push('stacked');
  if (report.rawOutsideTrayDice > 0) issues.push('outside-tray');
  if (report.rawLiftedDice > 0) issues.push('lifted');
  if (report.rawLowReadabilityDice > 0) issues.push('low-readability');
  if (report.rawMaxLinearSpeed >= REST_LINEAR_SPEED) issues.push('linear-speed');
  if (report.rawMaxAngularSpeed >= REST_ANGULAR_SPEED) issues.push('angular-speed');
  return issues;
}
