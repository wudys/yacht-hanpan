import { describe, expect, test } from 'bun:test';

import { type DieFace, type DieSlot } from '../contract';
import { projectAcceptedFaces, sampleCorrelations } from './sample-correlations';
import { type AcceptedFaceSample } from './sample-correlations';

describe('sample correlation axes', () => {
  test('computes known positive and negative correlations regardless of input order', () => {
    const samples = samplesFromRows([
      [1, 6, 1, 6, 1],
      [2, 5, 2, 5, 2],
      [3, 4, 3, 4, 3],
    ]);
    const result = sampleCorrelations(samples, 3, [0, 1, 2, 3, 4]);

    expect(sampleCorrelations(samples.slice().reverse(), 3, [0, 1, 2, 3, 4])).toEqual(result);
    expect(result.temporal).toEqual(
      ([0, 1, 2, 3, 4] as const).map((slot) => ({ slot, pairCount: 2, correlation: 1 })),
    );
    expect(result.withinRoll).toHaveLength(10);
    expect(result.withinRoll.find(({ slots }) => slots[0] === 0 && slots[1] === 1)).toEqual({
      slots: [0, 1],
      pairCount: 3,
      correlation: -1,
    });
    expect(result.withinRoll.find(({ slots }) => slots[0] === 0 && slots[1] === 2)).toEqual({
      slots: [0, 2],
      pairCount: 3,
      correlation: 1,
    });
    const alternating = samplesFromRows([
      [1, 6, 1, 6, 1],
      [6, 1, 6, 1, 6],
      [1, 6, 1, 6, 1],
    ]);
    for (const diagnostic of sampleCorrelations(alternating, 3, [0, 1, 2, 3, 4]).temporal) {
      expect(diagnostic.correlation).toBe(-1);
    }
  });

  test('detects consecutive duplicate rolls on the temporal axis with independent slots', () => {
    const rows = independentRows(200, 0x12345678).flatMap((row) => [row, row]);
    const result = sampleCorrelations(samplesFromRows(rows), 400, [0, 1, 2, 3, 4]);

    for (const diagnostic of result.temporal) {
      expect(diagnostic.pairCount).toBe(399);
      expect(diagnostic.correlation).toBeGreaterThan(0.2);
    }
    for (const diagnostic of result.withinRoll) {
      expect(diagnostic.pairCount).toBe(400);
      expect(Math.abs(diagnostic.correlation)).toBeLessThan(0.2);
    }
  });

  test('detects replicated slots within each roll without temporal reuse', () => {
    const rows = independentRows(400, 0x87654321).map((row) => Array<DieFace>(5).fill(row[0]));
    const result = sampleCorrelations(samplesFromRows(rows), 400, [0, 1, 2, 3, 4]);

    for (const diagnostic of result.temporal) {
      expect(Math.abs(diagnostic.correlation)).toBeLessThan(0.2);
    }
    for (const diagnostic of result.withinRoll) {
      expect(diagnostic.correlation).toBe(1);
    }
  });

  test('rejects a missing slot and an entirely missing roll instead of dropping them', () => {
    const samples = samplesFromRows(independentRows(4, 0x12345678));

    expect(() => sampleCorrelations(samples.slice(0, -1), 4, [0, 1, 2, 3, 4])).toThrow(
      'Missing slot 4 in roll 3',
    );
    expect(() =>
      sampleCorrelations(
        samples.filter(({ acceptedOrdinal }) => acceptedOrdinal !== 1),
        4,
        [0, 1, 2, 3, 4],
      ),
    ).toThrow('Missing slot 0 in roll 1');
  });

  test('rejects duplicate coordinates and unexpected acceptedOrdinals or slots', () => {
    const samples = samplesFromRows(independentRows(4, 0x12345678));

    expect(() => sampleCorrelations([...samples, samples[0]], 4, [0, 1, 2, 3, 4])).toThrow(
      'Duplicate slot 0 in roll 0',
    );
    for (const acceptedOrdinal of [-1, 0.5, 4, Number.NaN]) {
      expect(() =>
        sampleCorrelations(
          [{ ...samples[0], acceptedOrdinal }, ...samples.slice(1)],
          4,
          [0, 1, 2, 3, 4],
        ),
      ).toThrow('Unexpected accepted ordinal');
    }
    expect(() =>
      sampleCorrelations(
        [{ ...samples[0], slot: 5 as DieSlot }, ...samples.slice(1)],
        4,
        [0, 1, 2, 3, 4],
      ),
    ).toThrow('Unexpected slot 5 in roll 0');
  });

  test('rejects non-finite faces, zero variance and insufficient roll counts', () => {
    const samples = samplesFromRows(independentRows(4, 0x12345678));

    for (const face of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        sampleCorrelations(
          [{ ...samples[0], face: face as DieFace }, ...samples.slice(1)],
          4,
          [0, 1, 2, 3, 4],
        ),
      ).toThrow('Non-finite face in roll 0, slot 0');
    }
    expect(() =>
      sampleCorrelations(
        samples.map((sample) => (sample.slot === 0 ? { ...sample, face: 1 } : sample)),
        4,
        [0, 1, 2, 3, 4],
      ),
    ).toThrow('Undefined correlation for temporal slot 0, 3 pairs');
    for (const count of [0, 2, 3.5, Number.NaN]) {
      expect(() => sampleCorrelations(samples, count, [0, 1, 2, 3, 4])).toThrow(
        'at least 3 complete rolls',
      );
    }
  });
});

function samplesFromRows(rows: readonly (readonly DieFace[])[]): AcceptedFaceSample[] {
  return rows.flatMap((row, acceptedOrdinal) =>
    ([0, 1, 2, 3, 4] as const).map((slot) => ({
      acceptedOrdinal,
      slot,
      face: row[slot],
    })),
  );
}

function independentRows(count: number, seed: number): DieFace[][] {
  // A fixed synthetic stream keeps the two coupling fixtures independent of physics/RNG changes.
  let state = seed;
  return Array.from({ length: count }, () =>
    Array.from({ length: 5 }, () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (((state >>> 0) % 6) + 1) as DieFace;
    }),
  );
}

test('projects sorted attempted coordinates without rewriting raw samples', () => {
  const raw = [9, 2, 5].flatMap((attemptSequence) => [
    { attemptSequence, slot: 4 as const, face: 2 as const },
  ]);
  expect(projectAcceptedFaces(raw)).toEqual([
    { acceptedOrdinal: 2, slot: 4, face: 2 },
    { acceptedOrdinal: 0, slot: 4, face: 2 },
    { acceptedOrdinal: 1, slot: 4, face: 2 },
  ]);
  expect(raw.map(({ attemptSequence }) => attemptSequence)).toEqual([9, 2, 5]);
});
test('supports one die and sparse ordered physical slots', () => {
  const samples = [1, 2, 3].flatMap((face, acceptedOrdinal) => [
    { acceptedOrdinal, slot: 4 as const, face: face as DieFace },
  ]);
  expect(sampleCorrelations(samples, 3, [4]).withinRoll).toEqual([]);
  expect(sampleCorrelations(samples, 3, [4]).temporal[0]).toEqual({
    slot: 4,
    pairCount: 2,
    correlation: 1,
  });
  const sparse = samples.flatMap((s) => [
    s,
    { ...s, slot: 1 as const, face: (7 - s.face) as DieFace },
  ]);
  expect(sampleCorrelations(sparse, 3, [1, 4]).withinRoll[0]).toEqual({
    slots: [1, 4],
    pairCount: 3,
    correlation: -1,
  });
  expect(() => sampleCorrelations(samples, 3, [4, 4])).toThrow('Expected slots');
});
