import { expect, test } from 'bun:test';

import { runGameServerProcess } from '@/main';
import {
  ROLL_SIMULATION_EXECUTOR_ERROR_CODE,
  RollSimulationExecutorError,
} from '@/roll/roll-simulation-executor';
import type { ServerDiagnostics } from '@/runtime/server-diagnostics';

function fixture() {
  const reports: Array<{ error: unknown; operation: string }> = [];
  let closes = 0;
  const diagnostics: ServerDiagnostics = {
    reportUnexpected: (error, operation) => {
      reports.push({ error, operation });
    },
    close: async () => {
      closes += 1;
    },
  };
  return { diagnostics, reports, closes: () => closes };
}

test('startup preserves the original error and closes diagnostics without an unhandled rejection', async () => {
  const previous = process.exitCode ?? 0;
  const value = fixture();
  const error = new TypeError('private startup', { cause: new Error('private cause') });
  try {
    await runGameServerProcess(value.diagnostics, async () => {
      throw error;
    });
    expect(value.reports).toEqual([{ error, operation: 'startup' }]);
    expect(value.reports[0]?.error).toBe(error);
    expect(value.closes()).toBe(1);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
  }
});

test('already reported worker startup unavailability exits unsuccessfully without a synthetic issue', async () => {
  const previous = process.exitCode ?? 0;
  const value = fixture();
  try {
    await runGameServerProcess(value.diagnostics, async () => {
      throw new RollSimulationExecutorError(ROLL_SIMULATION_EXECUTOR_ERROR_CODE.UNAVAILABLE);
    });
    expect(value.reports).toEqual([]);
    expect(value.closes()).toBe(1);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
  }
});

test('shutdown closes once across signals and preserves its original failure', async () => {
  const previous = process.exitCode ?? 0;
  const value = fixture();
  const error = new RangeError('private shutdown');
  let calls = 0;
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  try {
    await runGameServerProcess(value.diagnostics, async (reporter) => {
      expect(reporter).toBe(value.diagnostics.reportUnexpected);
      return {
        url: 'http://example.invalid',
        close: async () => {
          calls += 1;
          throw error;
        },
      };
    });
    process.emit('SIGTERM');
    process.emit('SIGINT');
    await Bun.sleep(0);
    expect(calls).toBe(1);
    expect(value.reports).toEqual([{ error, operation: 'shutdown' }]);
    expect(value.closes()).toBe(1);
    expect(process.exitCode).toBe(1);
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  } finally {
    process.exitCode = previous;
  }
});

test('shutdown cleanup and failure exit survive an injected reporting failure', async () => {
  const previous = process.exitCode ?? 0;
  const value = fixture();
  const diagnostics = {
    ...value.diagnostics,
    reportUnexpected: () => {
      throw new Error('diagnostic');
    },
  };
  try {
    await runGameServerProcess(diagnostics, async () => ({
      url: 'http://example.invalid',
      close: async () => {
        throw new Error('close');
      },
    }));
    process.emit('SIGTERM');
    await Bun.sleep(0);
    expect(value.closes()).toBe(1);
    expect(process.exitCode).toBe(1);
  } finally {
    process.exitCode = previous;
  }
});

test('normal shutdown closes diagnostics without reporting or a failure exit', async () => {
  const previous = process.exitCode ?? 0;
  const value = fixture();
  try {
    await runGameServerProcess(value.diagnostics, async () => ({
      url: 'http://example.invalid',
      close: async () => undefined,
    }));
    process.emit('SIGTERM');
    await Bun.sleep(0);
    expect(value.reports).toEqual([]);
    expect(value.closes()).toBe(1);
    expect(process.exitCode).toBe(0);
  } finally {
    process.exitCode = previous;
  }
});
