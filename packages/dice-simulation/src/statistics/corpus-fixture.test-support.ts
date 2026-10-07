import { inputManifestHash } from './authoritative-roll-corpus';

export function corpusFixture() {
  const input = {
    rollId: 'roll-0',
    seed: 'seed-0',
    pourStyle: 'burst' as const,
    rolledSlots: [1, 4] as const,
  };
  const outcome = {
    input,
    authoritativeValuesBySlot: [
      { slot: 1 as const, value: 2 as const },
      { slot: 4 as const, value: 5 as const },
    ],
  };
  const corpus = {
    kind: 'authoritative-roll-corpus' as const,
    schemaVersion: 1 as const,
    completed: true,
    provenance: {
      revision: 'test',
      dirty: false,
      bunVersion: '1.4.2',
      rapierVersion: '0.19.3',
      simulationVersion: 'test',
      timelineSchemaVersion: 'dice-timeline-v4',
      prefix: 'test',
      startedAt: '2026-10-08T00:00:00.000Z',
      finishedAt: '2026-10-08T00:01:00.000Z',
      budgets: { commandMs: 15000, queueMs: 10000, jobMs: 10000 },
      pool: { workerCount: 1, maxQueueSize: 1 },
      inputManifestSha256: '',
      runner: 'test',
      sourceSha256: 'a'.repeat(64),
    },
    groups: [{ pourStyle: 'burst' as const, rolledSlots: [1, 4] as const, plannedCommands: 1 }],
    commands: [
      {
        commandOrdinal: 0,
        groupOrdinal: 0,
        rollId: 'roll-0',
        seedBank: ['seed-0', 'seed-1', 'seed-2'],
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
          contract: {
            releaseId: 'test',
            gameProtocolVersion: 'test',
            simulationVersion: 'test',
            timelineSchemaVersion: 'dice-timeline-v4',
          },
        },
      },
    ],
  };
  corpus.provenance.inputManifestSha256 = inputManifestHash(corpus);
  return corpus;
}
