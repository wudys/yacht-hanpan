import { access, rm } from 'node:fs/promises';
import * as fileSystem from 'node:fs/promises';
import { dirname } from 'node:path';

import { expect, spyOn, test } from 'bun:test';

import { RollSimulationWorkerPool } from '@/roll/worker/roll-simulation-worker-pool';

import { verifyBuiltWorker, verifyBuiltWorkerBudgetExpiry } from './built-roll-worker';

test.each(['crash', 'budget'] as const)(
  'removes the acquired %s wrapper directory and preserves a write failure',
  async (wrapper) => {
    const original = new Error('wrapper write failed');
    let directory: string | undefined;
    const write = spyOn(Bun, 'write').mockImplementation(async (path) => {
      if (typeof path !== 'string') throw new Error('expected a wrapper path');
      directory = dirname(path);
      throw original;
    });
    try {
      await expect(
        wrapper === 'crash' ? verifyBuiltWorker() : verifyBuiltWorkerBudgetExpiry(),
      ).rejects.toBe(original);
      expect(directory).toBeDefined();
      if (directory === undefined) throw new Error('wrapper directory was not acquired');
      await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      write.mockRestore();
      if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    }
  },
);

test('preserves a wrapper write failure when directory removal also fails', async () => {
  const original = new Error('wrapper write failed');
  const removal = new Error('wrapper removal failed');
  let directory: string | undefined;
  const write = spyOn(Bun, 'write').mockImplementation(async (path) => {
    if (typeof path !== 'string') throw new Error('expected a wrapper path');
    directory = dirname(path);
    throw original;
  });
  const remove = spyOn(fileSystem, 'rm').mockRejectedValue(removal);
  const report = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await expect(verifyBuiltWorkerBudgetExpiry()).rejects.toBe(original);
    expect(directory).toBeDefined();
    expect(remove).toHaveBeenCalledWith(directory, { recursive: true, force: true });
    expect(report).toHaveBeenCalledWith('Built worker wrapper cleanup failed:', removal);
  } finally {
    write.mockRestore();
    remove.mockRestore();
    report.mockRestore();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});

test('removes the wrapper after pool close failure and preserves the startup failure', async () => {
  const original = new Error('worker startup failed');
  const cleanup = new Error('pool close failed');
  const write = spyOn(Bun, 'write');
  const start = spyOn(RollSimulationWorkerPool.prototype, 'start').mockRejectedValue(original);
  const close = spyOn(RollSimulationWorkerPool.prototype, 'close').mockRejectedValue(cleanup);
  const report = spyOn(console, 'error').mockImplementation(() => undefined);
  let directory: string | undefined;
  try {
    await expect(verifyBuiltWorkerBudgetExpiry()).rejects.toBe(original);
    const path = write.mock.calls[0]?.[0];
    if (typeof path !== 'string') throw new Error('wrapper directory was not acquired');
    directory = dirname(path);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith('Built worker wrapper cleanup failed:', cleanup);
  } finally {
    write.mockRestore();
    start.mockRestore();
    close.mockRestore();
    report.mockRestore();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  }
});
