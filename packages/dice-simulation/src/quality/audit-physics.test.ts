import { beforeAll, expect, test } from 'bun:test';

import { initializeDeterministicRapierForBun } from '../rapier/bun';
import { auditPhysics } from './audit-physics';

beforeAll(initializeDeterministicRapierForBun);

test.each([
  {
    seed: '57b63a0ec375ad0c46eff21eddb2495f034b6e58b0762d581c76f438edbaaeaf',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3, 4],
    reason: 'stable-stack',
    simulationMs: 2617,
  },
  {
    seed: 'bd8b8c3e8b3871db1c966a62fd23d5d62ccfd105d5d3cf0e17fb6572828ca392',
    pourStyle: 'burst',
    rolledSlots: [0, 1, 2, 3],
    reason: 'repeated-assist',
    simulationMs: 3250,
  },
] as const)('audit classifies $reason with its raw stopping pose and time', (fixture) => {
  const report = auditPhysics({
    rollId: 'audit-rejected',
    seed: fixture.seed,
    pourStyle: fixture.pourStyle,
    rolledSlots: fixture.rolledSlots,
  });
  expect(report.status).toBe('rejected');
  if (report.status !== 'rejected') throw new Error('Expected the known stack rejection');
  expect(report.reason).toBe(fixture.reason);
  expect(report.simulationMs).toBe(fixture.simulationMs);
  expect(report.raw.simulationMs).toBe(report.simulationMs);
  expect(report.raw.rejection?.reason).toBe(report.reason);
  expect(report.raw.dice).toHaveLength(fixture.rolledSlots.length);
  expect('values' in report).toBe(false);
  expect('qualityIssues' in report).toBe(false);
});

test('audit does not convert invalid inputs into ordinary physical rejections', () => {
  expect(() =>
    auditPhysics({ rollId: 'invalid', seed: 'invalid', pourStyle: 'oblique', rolledSlots: [4, 1] }),
  ).toThrow();
});

test('audit still measures raw and final timeline pose drift for accepted candidates', () => {
  const report = auditPhysics({
    rollId: 'audit-accepted',
    seed: 'audit-accepted',
    pourStyle: 'oblique',
    rolledSlots: [0, 4],
  });
  expect(report.status).toBe('accepted');
  if (report.status !== 'accepted') throw new Error('Expected the known accepted candidate');
  expect(report.values).toHaveLength(2);
  expect(report.qualityIssues).toEqual([]);
  expect(report.facesPreserved).toBe(true);
});
