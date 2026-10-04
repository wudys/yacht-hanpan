import { type RollTimeline, TRAY_GEOMETRY } from '../contract';
import { recognizeTopFace, topFaceAlignment } from '../simulate/internal/result-recognition';
import { DIE_SIZE, FLOOR_TOP_Y } from '../simulate/internal/roll-simulation-constants';
import type { PhysicsCompletionSnapshot } from '../simulate/simulate-timeline';

/** Offline quality measurements, not acceptance/rejection criteria for authoritative rolls. */
export function measurePhysicsCompletion(
  raw: PhysicsCompletionSnapshot,
  displayedDice: RollTimeline['dice'],
) {
  const floor = FLOOR_TOP_Y + DIE_SIZE / 2;
  let rawStackedPairs = 0;
  let translatedDice = 0;
  let maxPlanarCorrectionDieWidths = 0;
  let maxAngularCorrectionRadians = 0;
  let displayCorrectionMs = 0;
  let facesPreserved = true;

  raw.dice.forEach((die, index) => {
    for (const other of raw.dice.slice(index + 1)) {
      const planar = Math.hypot(die.p[0] - other.p[0], die.p[2] - other.p[2]);
      const height = Math.abs(die.p[1] - other.p[1]);
      if (planar < DIE_SIZE * 1.02 && height > DIE_SIZE * 0.32) rawStackedPairs += 1;
    }
    const displayed = displayedDice.find((candidate) => candidate.slot === die.slot)!;
    const final = displayed.frames.at(-1)!;
    const correction = Math.hypot(die.p[0] - final.p[0], die.p[2] - final.p[2]) / DIE_SIZE;
    if (correction > 0.01) translatedDice += 1;
    maxPlanarCorrectionDieWidths = Math.max(maxPlanarCorrectionDieWidths, correction);
    const dot = Math.abs(die.q.reduce((sum, value, i) => sum + value * final.q[i], 0));
    const normalizedDot = dot / (Math.hypot(...die.q) * Math.hypot(...final.q));
    maxAngularCorrectionRadians = Math.max(
      maxAngularCorrectionRadians,
      2 * Math.acos(Math.min(1, normalizedDot)),
    );
    displayCorrectionMs = Math.max(
      displayCorrectionMs,
      final.t - displayed.frames[die.frameIndex].t,
    );
    facesPreserved &&=
      recognizeTopFace(die.q) === displayed.value && recognizeTopFace(final.q) === displayed.value;
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
    displayCorrectionMs,
    facesPreserved,
  };
}
