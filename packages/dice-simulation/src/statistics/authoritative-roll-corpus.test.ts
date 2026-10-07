import { expect, test } from 'bun:test';

import { parseAuthoritativeRollCorpus } from './authoritative-roll-corpus';
import { corpusFixture } from './corpus-fixture.test-support';

test('validates manifest identity and accepted final agreement across the file boundary', () => {
  const corpus = corpusFixture();
  expect(parseAuthoritativeRollCorpus(JSON.parse(JSON.stringify(corpus)))).toEqual(corpus);
  const wrong = structuredClone(corpus);
  wrong.commands[0].final.authoritativeValuesBySlot = [
    { slot: 1, value: 3 as 2 },
    { slot: 4, value: 5 },
  ];
  expect(() => parseAuthoritativeRollCorpus(wrong)).toThrow('final');
  wrong.commands[0].seedBank[0] = 'replaced';
  expect(() => parseAuthoritativeRollCorpus(wrong)).toThrow();
});

test('rejects incomplete, missing/duplicated coordinates, invalid faces and hashes', () => {
  const corpus = corpusFixture();
  for (const value of [
    { ...corpus, completed: false },
    { ...corpus, commands: [] },
    { ...corpus, commands: [...corpus.commands, ...corpus.commands] },
    { ...corpus, provenance: { ...corpus.provenance, inputManifestSha256: 'b'.repeat(64) } },
    { ...corpus, groups: [{ ...corpus.groups[0], rolledSlots: [1, 1] }] },
  ])
    expect(() => parseAuthoritativeRollCorpus(value)).toThrow();
});

test('preserves observed candidate identity errors and late/zero-attempt failures', () => {
  const corpus = corpusFixture();
  const mismatch = structuredClone(corpus);
  mismatch.commands[0].attempts[0].observation.outcome.input = {
    ...mismatch.commands[0].attempts[0].input,
    rollId: 'wrong',
  };
  const failed = {
    ...mismatch,
    commands: [{ ...mismatch.commands[0], final: { status: 'failed', reason: 'unavailable' } }],
  };
  expect(parseAuthoritativeRollCorpus(failed).commands[0].attempts).toHaveLength(1);
  expect(
    parseAuthoritativeRollCorpus({
      ...failed,
      commands: [{ ...failed.commands[0], attempts: [], remainingBudgetMs: null }],
    }).commands[0].attempts,
  ).toEqual([]);
});

test('rejects invalid actual observations, elapsed time and seed-only request changes', () => {
  for (const change of [
    (corpus: ReturnType<typeof corpusFixture>) => {
      corpus.commands[0].attempts[0].attemptOrdinal = 1;
    },
    (corpus: ReturnType<typeof corpusFixture>) => {
      corpus.commands[0].attempts[0].elapsedMs = Number.NaN;
    },
    (corpus: ReturnType<typeof corpusFixture>) => {
      corpus.commands[0].attempts[0].input = {
        ...corpus.commands[0].attempts[0].input,
        seed: 'unplanned',
      };
    },
    (corpus: ReturnType<typeof corpusFixture>) => {
      corpus.commands[0].attempts[0].observation.outcome.authoritativeValuesBySlot = [
        { slot: 1, value: 7 as 2 },
        { slot: 4, value: 5 },
      ];
    },
    (corpus: ReturnType<typeof corpusFixture>) => {
      corpus.commands[0].attempts.push(...Array(3).fill(corpus.commands[0].attempts[0]));
    },
  ]) {
    const corpus = corpusFixture();
    change(corpus);
    expect(() => parseAuthoritativeRollCorpus(corpus)).toThrow();
  }
  const corpus = corpusFixture();
  expect(() =>
    parseAuthoritativeRollCorpus({
      ...corpus,
      commands: [
        {
          ...corpus.commands[0],
          final: { status: 'failed', reason: 'unavailable', authoritativeValuesBySlot: [] },
        },
      ],
    }),
  ).toThrow('final');
});

test('accepted slot/value agreement ignores object key order but retains array order', () => {
  const corpus = corpusFixture();
  corpus.commands[0].attempts[0].observation.outcome.authoritativeValuesBySlot = [
    { value: 2, slot: 1 },
    { value: 5, slot: 4 },
  ];
  expect(parseAuthoritativeRollCorpus(JSON.parse(JSON.stringify(corpus)))).toEqual(corpus);
  corpus.commands[0].attempts[0].observation.outcome.authoritativeValuesBySlot.reverse();
  expect(() => parseAuthoritativeRollCorpus(corpus)).toThrow('observation');
});

test('requires finite remaining budget after attempts and null only for zero attempts', () => {
  const corpus = corpusFixture();
  for (const remainingBudgetMs of [undefined, null, Number.NaN, Infinity]) {
    expect(() =>
      parseAuthoritativeRollCorpus({
        ...corpus,
        commands: [{ ...corpus.commands[0], remainingBudgetMs }],
      }),
    ).toThrow('remainingBudgetMs');
  }
  for (const remainingBudgetMs of [-1, 0, 1]) {
    expect(
      parseAuthoritativeRollCorpus({
        ...corpus,
        commands: [
          {
            ...corpus.commands[0],
            remainingBudgetMs,
            final: { status: 'failed', reason: 'unavailable' },
          },
        ],
      }).commands[0].attempts,
    ).toHaveLength(1);
  }
  const command = {
    ...corpus.commands[0],
    attempts: [],
    final: { status: 'failed', reason: 'unavailable' },
  };
  expect(() =>
    parseAuthoritativeRollCorpus({ ...corpus, commands: [{ ...command, remainingBudgetMs: 0 }] }),
  ).toThrow('remainingBudgetMs');
  expect(
    parseAuthoritativeRollCorpus({ ...corpus, commands: [{ ...command, remainingBudgetMs: null }] })
      .commands[0].attempts,
  ).toHaveLength(0);
});
