import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';

import { SystemTaskScheduler } from '@/runtime/task-scheduler';

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('SystemTaskScheduler', () => {
  test('reports rejected work instead of leaking an unhandled rejection', async () => {
    const reported = Promise.withResolvers<unknown>();
    const scheduler = new SystemTaskScheduler({ now: () => 1_000 }, reported.resolve);
    const failure = new Error('scheduled failure');

    scheduler.schedule('room', 1_000, () => Promise.reject(failure));
    jest.advanceTimersByTime(0);

    expect(await reported.promise).toBe(failure);
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
      jest.advanceTimersByTime(19);
      await Promise.resolve();
      expect(calls).toEqual([]);
      jest.advanceTimersByTime(1);
      await Promise.resolve();

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
      jest.advanceTimersByTime(20);
      await Promise.resolve();

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
      jest.advanceTimersByTime(20);
      await Promise.resolve();

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
    jest.advanceTimersByTime(0);
    await Promise.resolve();

    expect(calls).toEqual([]);
  });
});
