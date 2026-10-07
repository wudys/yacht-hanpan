import { expect, test } from 'bun:test';

import { type DieFace, type DieSlot, type PourStyle } from '../contract';
import {
  type AuthoritativeRollCorpus,
  type CorpusCommand,
  inputManifestHash,
  parseAuthoritativeRollCorpus,
} from './authoritative-roll-corpus';
import { corpusFixture } from './corpus-fixture.test-support';
import { analyzeFinalRolls, exactIndependentReference } from './final-roll-statistics';

function fromRows(
  rows: readonly (readonly number[])[],
  styles: readonly PourStyle[] = ['burst'],
): AuthoritativeRollCorpus {
  const base = corpusFixture();
  const rolledSlots = rows[0].map((_, slot) => slot as DieSlot);
  const groups = styles.map((pourStyle) => ({
    pourStyle,
    rolledSlots,
    plannedCommands: rows.length,
  }));
  const commands = styles.flatMap((pourStyle, groupOrdinal) =>
    rows.map((faces, row) => {
      const commandOrdinal = groupOrdinal * rows.length + row;
      const input = {
        rollId: `roll-${commandOrdinal}`,
        seed: `seed-${commandOrdinal}-0`,
        pourStyle,
        rolledSlots,
      };
      const outcome = {
        input,
        authoritativeValuesBySlot: faces.map((face, index) => ({
          slot: rolledSlots[index],
          value: (groupOrdinal === 1 ? 7 - face : face) as DieFace,
        })),
      };
      return {
        commandOrdinal,
        groupOrdinal,
        rollId: input.rollId,
        seedBank: [input.seed, `seed-${commandOrdinal}-1`, `seed-${commandOrdinal}-2`],
        attempts: [
          {
            attemptOrdinal: 0,
            input,
            elapsedMs: 1,
            observation: { status: 'accepted' as const, outcome },
          },
        ],
        elapsedMs: 2,
        remainingBudgetMs: 14998,
        final: {
          status: 'accepted' as const,
          ...outcome,
          contract: base.commands[0].final.contract,
        },
      };
    }),
  );
  const corpus = { ...base, groups, commands };
  corpus.provenance.inputManifestSha256 = inputManifestHash(corpus);
  return parseAuthoritativeRollCorpus(corpus);
}

test('opposite style bias is exposed even when pooled face counts are uniform', () => {
  const corpus = fromRows([[1], [2], [3], [2], [1], [3]], ['burst', 'oblique']);
  const report = analyzeFinalRolls(corpus);
  expect(report.status).toBe('complete');
  expect(report.pooled.faces.chiSquare).toBe(0);
  expect(report.groups[0].faces.chiSquare).toBe(6);
  expect(report.groups[1].faces.chiSquare).toBe(6);
  expect(report.groups[0].withinRoll).toEqual([]);
  expect(report.groups[0].slots[0].slot).toBe(0);
});

test('exact sum/partition reference detects higher order joint bias with uniform marginals', () => {
  const rows = Array.from({ length: 36 }, (_, row) => {
    const left = row % 6;
    const right = Math.floor(row / 6);
    return [left + 1, right + 1, ((12 - left - right) % 6) + 1];
  });
  const report = analyzeFinalRolls(fromRows(rows));
  expect(report.groups[0].slots.every(({ faces }) => faces.chiSquare === 0)).toBe(true);
  const partition = report.groups[0].multiplicity.find(({ outcome }) => outcome === '3');
  expect(partition?.probability).toBe(1 / 36);
  expect(partition?.observed).toBe(3);
  expect(partition?.expected).toBe(1);
  for (const pair of report.groups[0].withinRoll) expect(pair.correlation).toBeCloseTo(0, 12);
  const sum = report.groups[0].sums.find(({ outcome }) => outcome === '18');
  expect(sum?.observed).toBe(0);
  expect(sum?.expected).toBe(1 / 6);
  for (let count = 1; count <= 5; count += 1) {
    const reference = exactIndependentReference(count);
    expect(reference.totalOutcomes).toBe(6 ** count);
    expect(reference.sums.reduce((total, entry) => total + entry.combinations, 0)).toBe(6 ** count);
    expect(reference.multiplicity.reduce((total, entry) => total + entry.combinations, 0)).toBe(
      6 ** count,
    );
  }
});

test('cloned slots and repeated outcomes expose distinct correlation axes', () => {
  const independent = Array.from({ length: 200 }, (_, index) => [
    (index % 6) + 1,
    (Math.floor(index / 6) % 6) + 1,
  ]);
  const clone = analyzeFinalRolls(fromRows(independent.map(([face]) => [face, face])));
  expect(clone.groups[0].withinRoll[0].correlation).toBe(1);
  const repeated = analyzeFinalRolls(fromRows(independent.flatMap((row) => [row, row])));
  expect(repeated.groups[0].temporal[0].correlation).toBeGreaterThan(0.2);
  expect(Math.abs(repeated.groups[0].withinRoll[0].correlation!)).toBeLessThan(0.2);
});

test('reports undefined required correlations and preserves all failure denominators', () => {
  const corpus = fromRows([[1], [2], [3], [4], [5], [6]]);
  const commands: CorpusCommand[] = [...corpus.commands];
  commands[1] = {
    ...commands[1],
    attempts: [],
    remainingBudgetMs: null,
    final: { status: 'failed', reason: 'unavailable' },
  };
  commands[2] = { ...commands[2], final: { status: 'failed', reason: 'unavailable' } }; // late accepted
  commands[3] = {
    ...commands[3],
    attempts: commands[3].seedBank.map((seed, attemptOrdinal) => {
      const input = { ...commands[3].attempts[0].input, seed };
      return {
        attemptOrdinal,
        input,
        elapsedMs: 1,
        observation: { status: 'rejected', input, reason: 'stable-stack', simulationMs: 1 },
      };
    }),
    final: { status: 'failed', reason: 'unavailable' },
  };
  commands[4] = {
    ...commands[4],
    attempts: [
      { ...commands[4].attempts[0], observation: { status: 'executor-error', code: 'unexpected' } },
    ],
    final: { status: 'failed', reason: 'unavailable' },
  };
  commands[5] = {
    ...commands[5],
    attempts: [
      { ...commands[5].attempts[0], observation: { status: 'invalid-result', reason: 'shape' } },
    ],
    final: { status: 'failed', reason: 'unavailable' },
  };
  const report = analyzeFinalRolls({ ...corpus, commands });
  expect(report.status).toBe('execution-failure');
  expect(report.denominators).toMatchObject({
    attemptedCandidates: 7,
    retriedCommands: 1,
    acceptedCommands: 1,
    failedCommands: 5,
    exhaustedCommands: 1,
    executionFailedCommands: 4,
    executorErrors: 1,
    invalidResults: 1,
    rejectedCandidates: { 'stable-stack': 3, 'repeated-assist': 0, 'unsettled-at-limit': 0 },
  });
  expect(report.groups[0].temporal[0]).toMatchObject({
    pairCount: 0,
    correlation: null,
    status: 'insufficient-data',
  });
  expect(report.groups[0].skippedFailedCommands).toBe(5);
  expect(analyzeFinalRolls(fromRows([[1], [1], [1]])).status).toBe('insufficient-data');
});

test('three physical rejections stay in denominators without an infrastructure failure status', () => {
  const corpus = fromRows([[1], [2], [4], [3]]);
  const commands: CorpusCommand[] = [...corpus.commands];
  const command = commands[1];
  commands[1] = {
    ...command,
    attempts: command.seedBank.map((seed, attemptOrdinal) => {
      const input = { ...command.attempts[0].input, seed };
      return {
        attemptOrdinal,
        input,
        elapsedMs: 1,
        observation: {
          status: 'rejected' as const,
          input,
          reason: 'stable-stack' as const,
          simulationMs: 1,
        },
      };
    }),
    final: { status: 'failed', reason: 'unavailable' },
  };
  const report = analyzeFinalRolls(parseAuthoritativeRollCorpus({ ...corpus, commands }));
  expect(report.status).toBe('complete');
  expect(report.denominators).toMatchObject({
    acceptedCommands: 3,
    failedCommands: 1,
    exhaustedCommands: 1,
    executionFailedCommands: 0,
  });
  expect(report.groups[0].acceptedCommandOrdinals).toEqual([0, 2, 3]);
  expect(report.groups[0].temporal[0].pairCount).toBe(2);
  expect(report.groups[0].skippedFailedCommands).toBe(1);
});

test('well shaped wrong-identity observations and capacity failures remain execution failures', () => {
  const corpus = fromRows([[1], [2], [3], [4], [5]]);
  const commands: CorpusCommand[] = [...corpus.commands];
  const command = commands[1];
  const { observation } = command.attempts[0];
  if (observation.status !== 'accepted') throw new Error('fixture requires accepted observation');
  commands[1] = {
    ...command,
    attempts: [
      {
        ...command.attempts[0],
        observation: {
          ...observation,
          outcome: {
            ...observation.outcome,
            input: { ...observation.outcome.input, seed: 'wrong-identity' },
          },
        },
      },
    ],
    final: { status: 'failed', reason: 'unavailable' },
  };
  commands[2] = {
    ...commands[2],
    attempts: [],
    remainingBudgetMs: null,
    final: { status: 'failed', reason: 'capacity' },
  };
  const report = analyzeFinalRolls(parseAuthoritativeRollCorpus({ ...corpus, commands }));
  expect(report.status).toBe('execution-failure');
  expect(report.denominators.mismatchedCandidates).toBe(1);
  expect(report.denominators.executionFailedCommands).toBe(2);
  expect(report.denominators.failedCommands).toBe(2);
});

test('deadline exhaustion after three matching rejections is an execution failure', () => {
  const corpus = fromRows([[1], [2], [4], [3]]);
  const command = corpus.commands[1];
  const attempts = command.seedBank.map((seed, attemptOrdinal) => {
    const input = { ...command.attempts[0].input, seed };
    return {
      attemptOrdinal,
      input,
      elapsedMs: 1,
      observation: {
        status: 'rejected' as const,
        input,
        reason: 'stable-stack' as const,
        simulationMs: 1,
      },
    };
  });
  for (const remainingBudgetMs of [0, -0.01]) {
    const commands = corpus.commands.map((original, ordinal) =>
      ordinal === 1
        ? {
            ...command,
            attempts,
            remainingBudgetMs,
            final: { status: 'failed' as const, reason: 'unavailable' as const },
          }
        : original,
    );
    const report = analyzeFinalRolls(parseAuthoritativeRollCorpus({ ...corpus, commands }));
    expect(report.status).toBe('execution-failure');
    expect(report.denominators).toMatchObject({
      exhaustedCommands: 0,
      executionFailedCommands: 1,
      rejectedCandidates: { 'stable-stack': 3, 'repeated-assist': 0, 'unsettled-at-limit': 0 },
    });
  }
  const commands = corpus.commands.map((original, ordinal) =>
    ordinal === 1
      ? {
          ...command,
          attempts,
          remainingBudgetMs: 0.01,
          final: { status: 'failed' as const, reason: 'unavailable' as const },
        }
      : original,
  );
  expect(analyzeFinalRolls(parseAuthoritativeRollCorpus({ ...corpus, commands })).status).toBe(
    'complete',
  );
});
