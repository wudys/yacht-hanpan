import { expect, test } from 'bun:test';

import { sampleRollInputs, sampleRolls } from './sample-rolls';

test('raw sampling retains rejected attempts and reason/time without fabricating face samples', async () => {
  const report = await sampleRollInputs([
    {
      rollId: 'sample-rejected',
      seed: '21f806f9d20df7231635b433a1dc99aa',
      pourStyle: 'burst',
      rolledSlots: [0, 1, 2, 3],
    },
    {
      rollId: 'sample-accepted',
      seed: 'sample-accepted',
      pourStyle: 'burst',
      rolledSlots: [0, 1, 2, 3],
    },
  ]);
  expect(report).toHaveLength(1);
  expect(report[0].attempted).toBe(2);
  expect(report[0].accepted).toBe(1);
  expect(report[0].rejected).toEqual([
    { attemptSequence: 0, reason: 'stable-stack', simulationMs: 2567 },
  ]);
  expect(report[0].samples).toHaveLength(4);
  expect(report[0].samples.every(({ attemptSequence }) => attemptSequence === 1)).toBe(true);
});

test('automaticstyle/count groups keep the fixed attempted denominator', async () => {
  const groups = await sampleRolls(2, 'sampler-groups');
  expect(groups.map(({ pourStyle, count }) => `${pourStyle}:${count}`)).toEqual([
    'burst:1',
    'burst:2',
    'burst:3',
    'burst:4',
    'burst:5',
    'oblique:1',
    'oblique:2',
    'oblique:3',
    'oblique:4',
    'oblique:5',
  ]);
  for (const group of groups) {
    expect(group.attempted).toBe(2);
    expect(group.accepted + group.rejected.length).toBe(2);
    expect(group.samples).toHaveLength(group.accepted * group.count);
  }
});

test('sparse ordered slot identities survive accepted statistics', async () => {
  const [group] = await sampleRollInputs([
    { rollId: 'sparse', seed: 'sparse', pourStyle: 'oblique', rolledSlots: [1, 4] },
  ]);
  expect(group.accepted).toBe(1);
  expect(group.samples.map(({ slot }) => slot)).toEqual([1, 4]);
});
