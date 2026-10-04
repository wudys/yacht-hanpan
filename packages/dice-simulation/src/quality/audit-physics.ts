import { type DieSlot, POUR_STYLES, type SimulationInput } from '../contract';
import { initializeDeterministicRapierForBun } from '../rapier/bun';
import {
  CupReleaseError,
  type PhysicsCompletionSnapshot,
  simulateRollTimeline,
} from '../simulate/simulate-timeline';
import { measurePhysicsCompletion, physicsCompletionIssues } from './physical-roll-audit';

const REGRESSIONS: readonly SimulationInput[] = [
  ['classic', 'classic', '103'],
  ['burst', 'toss', '14'],
  ['oblique', 'ricochet', '397'],
].map(([style, seedStyle, sequence]) => ({
  rollId: `quality-regression-${style}-${sequence}`,
  seed: `flow-audit-batch-20260918-${seedStyle}-${sequence}`,
  rolledSlots: [0, 1, 2, 3, 4],
  pourStyle: style as SimulationInput['pourStyle'],
}));

function audit(input: SimulationInput) {
  let raw: PhysicsCompletionSnapshot | undefined;
  const startedAt = performance.now();
  const timeline = simulateRollTimeline(input, (snapshot) => {
    raw = snapshot;
  });
  const simulationWallMs = performance.now() - startedAt;
  if (!raw) throw new Error('Physics audit snapshot was not collected');
  const measurements = measurePhysicsCompletion(raw, timeline.dice);
  return {
    ...measurements,
    qualityIssues: physicsCompletionIssues(measurements),
    durationMs: timeline.durationMs,
    simulationWallMs,
    values: timeline.dice.map((die) => die.value),
  };
}

async function main() {
  const partition = Bun.argv[2] ?? 'tuning';
  if (partition !== 'tuning' && partition !== 'validation' && partition !== 'acceptance') {
    throw new Error('Usage: audit:physics [tuning|validation|acceptance]');
  }
  await initializeDeterministicRapierForBun();
  const regressions = REGRESSIONS.map((input) => {
    try {
      return { input, report: audit(input) };
    } catch (error) {
      return {
        input,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof CupReleaseError ? { diagnostics: error.diagnostics } : {}),
      };
    }
  });
  const groups = [];
  for (const pourStyle of POUR_STYLES) {
    for (let count = 1; count <= 5; count += 1) {
      const reports: ReturnType<typeof audit>[] = [];
      const failures: {
        seed: string;
        error: string;
        diagnostics?: CupReleaseError['diagnostics'];
      }[] = [];
      const rawStackSeeds: string[] = [];
      const rawOutsideTraySeeds: string[] = [];
      const qualityFailures: { seed: string; issues: string[] }[] = [];
      const rolledSlots = Array.from({ length: count }, (_, index) => index as DieSlot);
      for (let sequence = 0; sequence < 50; sequence += 1) {
        const seed = `dice-quality-${partition}-${pourStyle}-${count}-${sequence}`;
        try {
          const report = audit({ rollId: seed, seed, rolledSlots, pourStyle });
          reports.push(report);
          if (report.rawStackedPairs > 0) rawStackSeeds.push(seed);
          if (report.rawOutsideTrayDice > 0) rawOutsideTraySeeds.push(seed);
          if (report.qualityIssues.length > 0)
            qualityFailures.push({ seed, issues: report.qualityIssues });
        } catch (error) {
          failures.push({
            seed,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof CupReleaseError ? { diagnostics: error.diagnostics } : {}),
          });
        }
      }
      const percentile = (values: number[], fraction: number) => {
        const sorted = [...values].sort((a, b) => a - b);
        return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? null;
      };
      groups.push({
        pourStyle,
        count,
        attempted: 50,
        completed: reports.length,
        failures,
        qualityFailures,
        rawStackSeeds,
        rawOutsideTraySeeds,
        rawLiftedRolls: reports.filter((r) => r.rawLiftedDice > 0).length,
        rawLowReadabilityRolls: reports.filter((r) => r.rawLowReadabilityDice > 0).length,
        translatedRolls: reports.filter((r) => r.translatedDice > 0).length,
        changedFaces: reports.filter((r) => !r.facesPreserved).length,
        maxPlanarCorrectionDieWidths: Math.max(
          0,
          ...reports.map((r) => r.maxPlanarCorrectionDieWidths),
        ),
        maxAngularCorrectionRadians: Math.max(
          0,
          ...reports.map((r) => r.maxAngularCorrectionRadians),
        ),
        rawMaxLinearSpeed: Math.max(0, ...reports.map((r) => r.rawMaxLinearSpeed)),
        rawMaxAngularSpeed: Math.max(0, ...reports.map((r) => r.rawMaxAngularSpeed)),
        durationP95Ms: percentile(
          reports.map((r) => r.durationMs),
          0.95,
        ),
        simulationWallP95Ms: percentile(
          reports.map((r) => r.simulationWallMs),
          0.95,
        ),
        faceCountsBySlot: rolledSlots.map((slot) =>
          Array.from(
            { length: 6 },
            (_, face) => reports.filter((r) => r.values[slot] === face + 1).length,
          ),
        ),
      });
    }
  }
  console.log(JSON.stringify({ partition, regressions, groups }, null, 2));
  if (
    regressions.some(
      (regression) => !regression.report || regression.report.qualityIssues.length > 0,
    ) ||
    groups.some((group) => group.failures.length > 0 || group.qualityFailures.length > 0)
  ) {
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
