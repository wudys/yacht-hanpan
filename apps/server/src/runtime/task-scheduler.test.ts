import { describe, expect, test } from 'bun:test';

import { SystemTaskScheduler } from '@/runtime/task-scheduler';

describe('SystemTaskScheduler', () => {
  test('reports rejected work instead of leaking an unhandled rejection', async () => {
    const errors: unknown[] = [];
    const scheduler = new SystemTaskScheduler({ now: () => 1_000 }, (error) => errors.push(error));
    const failure = new Error('scheduled failure');

    scheduler.schedule('room', 1_000, () => Promise.reject(failure));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(errors).toEqual([failure]);
    scheduler.close();
  });

  test('replacement prevents stale work after both scheduled deadlines', async () => {
    const calls: string[] = [];
    const scheduler = new SystemTaskScheduler({ now: () => 1_000 });

    try {
      scheduler.schedule('room', 1_010, () => {
        calls.push('stale');
      });
      scheduler.schedule('room', 1_020, () => {
        calls.push('current');
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));

      expect(calls).toEqual(['current']);
    } finally {
      scheduler.close();
    }
  });

  test('cancel prevents work after its scheduled deadline', async () => {
    const calls: string[] = [];
    const scheduler = new SystemTaskScheduler({ now: () => 1_000 });

    try {
      scheduler.schedule('room', 1_010, () => {
        calls.push('cancelled');
      });
      scheduler.cancel('room');
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(calls).toEqual([]);
    } finally {
      scheduler.close();
    }
  });

  test('close prevents pending work after its scheduled deadline', async () => {
    const calls: string[] = [];
    const scheduler = new SystemTaskScheduler({ now: () => 1_000 });

    try {
      scheduler.schedule('room', 1_010, () => {
        calls.push('closed');
      });
      scheduler.close();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));

      expect(calls).toEqual([]);
    } finally {
      scheduler.close();
    }
  });

  test('does not accept new work after close', async () => {
    const calls: string[] = [];
    const scheduler = new SystemTaskScheduler({ now: () => 1_000 });

    scheduler.close();
    scheduler.schedule('room', 1_000, () => {
      calls.push('late');
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(calls).toEqual([]);
  });
});
