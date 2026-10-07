import { type RollCandidateRejectionReason } from '../contract';
import {
  type AuthoritativeRollCorpus,
  type CorpusCommand,
  sameInput,
} from './authoritative-roll-corpus';
import { projectAcceptedFaces, sampleFaceCorrelation } from './sample-correlations';

export type AnalysisStatus =
  'complete' | 'insufficient-data' | 'invalid-input' | 'execution-failure';
export type AnalysisIssue = Readonly<{
  status: Exclude<AnalysisStatus, 'complete'>;
  location: string;
  reason: string;
}>;
type CorrelationResult = Readonly<{
  pairCount: number;
  correlation: number | null;
  status: 'defined' | 'insufficient-data' | 'zero-variance';
}>;

function denominators(commands: readonly CorpusCommand[], plannedCommands: number) {
  const rejectedCandidates: Record<RollCandidateRejectionReason, number> = {
    'stable-stack': 0,
    'repeated-assist': 0,
    'unsettled-at-limit': 0,
  };
  let attemptedCandidates = 0;
  let retriedCommands = 0;
  let acceptedCommands = 0;
  let failedCommands = 0;
  let exhaustedCommands = 0;
  let executionFailedCommands = 0;
  let executorErrors = 0;
  let invalidResults = 0;
  let mismatchedCandidates = 0;
  for (const command of commands) {
    attemptedCandidates += command.attempts.length;
    if (command.attempts.length > 1) retriedCommands += 1;
    if (command.final.status === 'accepted') acceptedCommands += 1;
    else {
      failedCommands += 1;
      if (exhausted(command)) exhaustedCommands += 1;
      else executionFailedCommands += 1;
    }
    for (const attempt of command.attempts) {
      const { observation } = attempt;
      if (observation.status === 'executor-error') executorErrors += 1;
      else if (observation.status === 'invalid-result') invalidResults += 1;
      else {
        if (observation.status === 'rejected') rejectedCandidates[observation.reason] += 1;
        const observedInput =
          observation.status === 'accepted' ? observation.outcome.input : observation.input;
        if (!sameInput(attempt.input, observedInput)) mismatchedCandidates += 1;
      }
    }
  }
  return {
    plannedCommands,
    logicalCommands: commands.length,
    attemptedCandidates,
    retriedCommands,
    acceptedCommands,
    failedCommands,
    exhaustedCommands,
    executionFailedCommands,
    rejectedCandidates,
    executorErrors,
    invalidResults,
    mismatchedCandidates,
  };
}

function exhausted(command: CorpusCommand): boolean {
  return (
    command.final.status === 'failed' &&
    command.final.reason === 'unavailable' &&
    command.remainingBudgetMs !== null &&
    command.remainingBudgetMs > 0 &&
    command.attempts.length === 3 &&
    command.attempts.every(
      (attempt) =>
        attempt.observation.status === 'rejected' &&
        sameInput(attempt.input, attempt.observation.input),
    )
  );
}

function faceDistribution(faces: readonly number[]) {
  const observed = [1, 2, 3, 4, 5, 6].map((face) => faces.filter((value) => value === face).length);
  const expectedPerFace = faces.length / 6;
  return {
    sampleCount: faces.length,
    observed,
    expectedPerFace,
    chiSquare:
      faces.length === 0
        ? null
        : observed.reduce(
            (sum, count) => sum + (count - expectedPerFace) ** 2 / expectedPerFace,
            0,
          ),
  };
}

/** Ordered enumeration retains higher order joint expectations even when marginals agree. */
export function exactIndependentReference(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 5)
    throw new Error('Reference requires 1–5 dice');
  const sums = new Map<string, number>();
  const multiplicity = new Map<string, number>();
  const totalOutcomes = 6 ** count;
  for (let ordinal = 0; ordinal < totalOutcomes; ordinal += 1) {
    let remaining = ordinal;
    const faces: number[] = [];
    for (let index = 0; index < count; index += 1) {
      faces.push((remaining % 6) + 1);
      remaining = Math.floor(remaining / 6);
    }
    increment(sums, String(faces.reduce((sum, face) => sum + face, 0)));
    increment(multiplicity, partition(faces));
  }
  const entries = (values: Map<string, number>) =>
    [...values].map(([outcome, combinations]) => ({
      outcome,
      combinations,
      probability: combinations / totalOutcomes,
    }));
  return {
    totalOutcomes,
    sums: entries(sums).sort((left, right) => Number(left.outcome) - Number(right.outcome)),
    multiplicity: entries(multiplicity).sort((left, right) =>
      left.outcome.localeCompare(right.outcome),
    ),
  };
}
function partition(faces: readonly number[]): string {
  return [1, 2, 3, 4, 5, 6]
    .map((face) => faces.filter((value) => value === face).length)
    .filter((count) => count > 0)
    .sort((a, b) => b - a)
    .join('+');
}
function increment(counts: Map<string, number>, key: string) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** Completion certifies aggregation only. No new fairness threshold is applied. */
export function analyzeFinalRolls(corpus: AuthoritativeRollCorpus) {
  const issues: AnalysisIssue[] = [];
  for (const command of corpus.commands) {
    const location = `commands[${command.commandOrdinal}]`;
    if (command.final.status === 'failed' && !exhausted(command))
      issues.push({
        status: 'execution-failure',
        location,
        reason: `authority failed (${command.final.reason}) outside three validated physical rejections completed before the deadline`,
      });
    for (const attempt of command.attempts) {
      const { observation } = attempt;
      const attemptLocation = `${location}.attempts[${attempt.attemptOrdinal}]`;
      if (observation.status === 'executor-error' || observation.status === 'invalid-result')
        issues.push({
          status: 'execution-failure',
          location: attemptLocation,
          reason: observation.status,
        });
      else {
        const observedInput =
          observation.status === 'accepted' ? observation.outcome.input : observation.input;
        if (!sameInput(observedInput, attempt.input))
          issues.push({
            status: 'execution-failure',
            location: attemptLocation,
            reason: 'candidate identity differs from requested input',
          });
      }
    }
  }
  const groups = corpus.groups.map((group, groupOrdinal) => {
    const commands = corpus.commands.filter((command) => command.groupOrdinal === groupOrdinal);
    const accepted = commands.filter((command) => command.final.status === 'accepted');
    const rows = accepted.map((command) =>
      command.final.status === 'accepted'
        ? command.final.authoritativeValuesBySlot.map(({ value }) => value)
        : [],
    );
    const samples = projectAcceptedFaces(
      accepted.flatMap((command) =>
        command.final.status === 'accepted'
          ? command.final.authoritativeValuesBySlot.map(({ slot, value }) => ({
              attemptSequence: command.commandOrdinal,
              slot,
              face: value,
            }))
          : [],
      ),
    );
    const bySlot = new Map(
      group.rolledSlots.map((slot) => [
        slot,
        samples.filter((sample) => sample.slot === slot).map(({ face }) => face),
      ]),
    );
    const correlate = (
      left: readonly number[],
      right: readonly number[],
      axis: string,
    ): CorrelationResult => {
      if (left.length < 2) {
        issues.push({
          status: 'insufficient-data',
          location: `groups[${groupOrdinal}].${axis}`,
          reason: 'requires at least two pairs',
        });
        return { pairCount: left.length, correlation: null, status: 'insufficient-data' };
      }
      try {
        return {
          pairCount: left.length,
          correlation: sampleFaceCorrelation(left, right, axis),
          status: 'defined',
        };
      } catch {
        issues.push({
          status: 'insufficient-data',
          location: `groups[${groupOrdinal}].${axis}`,
          reason: 'zero variance; correlation is undefined',
        });
        return { pairCount: left.length, correlation: null, status: 'zero-variance' };
      }
    };
    const temporal = group.rolledSlots.map((slot) => {
      const faces = bySlot.get(slot)!;
      return { slot, ...correlate(faces.slice(0, -1), faces.slice(1), `temporal.slot-${slot}`) };
    });
    const withinRoll = group.rolledSlots.flatMap((left, index) =>
      group.rolledSlots.slice(index + 1).map((right) => ({
        slots: [left, right] as const,
        ...correlate(bySlot.get(left)!, bySlot.get(right)!, `withinRoll.slots-${left}-${right}`),
      })),
    );
    const reference = exactIndependentReference(group.rolledSlots.length);
    const observedSums = new Map<string, number>();
    const observedPartitions = new Map<string, number>();
    for (const row of rows) {
      increment(observedSums, String(row.reduce((sum, value) => sum + value, 0)));
      increment(observedPartitions, partition(row));
    }
    const compare = (entries: typeof reference.sums, observed: Map<string, number>) =>
      entries.map((entry) => ({
        ...entry,
        expected: entry.probability * accepted.length,
        observed: observed.get(entry.outcome) ?? 0,
      }));
    return {
      groupOrdinal,
      pourStyle: group.pourStyle,
      count: group.rolledSlots.length,
      rolledSlots: group.rolledSlots,
      denominators: denominators(commands, group.plannedCommands),
      faces: faceDistribution(rows.flat()),
      slots: group.rolledSlots.map((slot) => ({
        slot,
        faces: faceDistribution(bySlot.get(slot)!),
      })),
      acceptedCommandOrdinals: accepted.map(({ commandOrdinal }) => commandOrdinal),
      skippedFailedCommands: commands.length - accepted.length,
      temporal,
      withinRoll,
      referenceTotalOutcomes: reference.totalOutcomes,
      multiplicity: compare(reference.multiplicity, observedPartitions),
      sums: compare(reference.sums, observedSums),
    };
  });
  const status: AnalysisStatus = issues.some((issue) => issue.status === 'execution-failure')
    ? 'execution-failure'
    : issues.length > 0
      ? 'insufficient-data'
      : 'complete';
  return {
    kind: 'authoritative-roll-analysis' as const,
    schemaVersion: 1 as const,
    sourceInputHash: corpus.provenance.inputManifestSha256,
    status,
    denominators: denominators(
      corpus.commands,
      corpus.groups.reduce((sum, group) => sum + group.plannedCommands, 0),
    ),
    groups,
    pooled: {
      faces: faceDistribution(
        corpus.commands.flatMap((command) =>
          command.final.status === 'accepted'
            ? command.final.authoritativeValuesBySlot.map(({ value }) => value)
            : [],
        ),
      ),
    },
    issues,
  };
}
