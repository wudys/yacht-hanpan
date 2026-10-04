import { describe, expect, test } from 'bun:test';

import {
  ADMISSION_OPERATION_FAILURE,
  ADMISSION_OPERATION_KIND,
  AdmissionOperationRegistry,
} from '@/rooms/admission/admission-operation-registry';

const OPERATION_ID = 'a6f9fc18-01e4-469c-8382-301e7d85654d';

describe('room admission operation registry', () => {
  test('shares one pending execution and replays the completed authority result', async () => {
    let executions = 0;
    let release: ((value: { token: string }) => void) | undefined;
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 128,
      ttlMs: 300_000,
    });
    const execute = () => {
      executions += 1;
      return new Promise<{ token: string }>((resolve) => {
        release = resolve;
      });
    };

    const first = registry.run(
      ADMISSION_OPERATION_KIND.CREATE_ROOM,
      OPERATION_ID,
      'client-1:profile-1',
      execute,
    );
    const duplicate = registry.run(
      ADMISSION_OPERATION_KIND.CREATE_ROOM,
      OPERATION_ID,
      'client-1:profile-1',
      execute,
    );
    await Promise.resolve();
    release?.({ token: 'same-secret' });

    expect(await first).toEqual({ ok: true, value: { token: 'same-secret' } });
    expect(await duplicate).toEqual({ ok: true, value: { token: 'same-secret' } });
    expect(
      await registry.run(
        ADMISSION_OPERATION_KIND.CREATE_ROOM,
        OPERATION_ID,
        'client-1:profile-1',
        execute,
      ),
    ).toEqual({ ok: true, value: { token: 'same-secret' } });
    expect(executions).toBe(1);
  });

  test('rejects reuse with another payload instead of replaying credentials', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 128,
      ttlMs: 300_000,
    });

    await registry.run(
      ADMISSION_OPERATION_KIND.JOIN_ROOM,
      OPERATION_ID,
      'room-1:profile-1',
      async () => 'joined',
    );

    expect(
      await registry.run(
        ADMISSION_OPERATION_KIND.JOIN_ROOM,
        OPERATION_ID,
        'room-2:profile-1',
        async () => 'wrong',
      ),
    ).toEqual({ ok: false, reason: ADMISSION_OPERATION_FAILURE.OPERATION_ID_REUSED });
  });

  test('keeps create and join results separate for the same operation ID', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 2,
      ttlMs: 100,
    });
    let executions = 0;
    const create = () =>
      registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', async () => {
        executions += 1;
        return 'creator-token';
      });
    const join = () =>
      registry.run(ADMISSION_OPERATION_KIND.JOIN_ROOM, OPERATION_ID, 'same', async () => {
        executions += 1;
        return 'joiner-token';
      });

    expect(await create()).toEqual({ ok: true, value: 'creator-token' });
    expect(await join()).toEqual({ ok: true, value: 'joiner-token' });
    expect(await create()).toEqual({ ok: true, value: 'creator-token' });
    expect(await join()).toEqual({ ok: true, value: 'joiner-token' });
    expect(executions).toBe(2);
  });

  test('evicts a completed result to admit a new operation while preserving pending duplicates', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 2,
      ttlMs: 100,
    });
    let completedExecutions = 0;
    const completed = () =>
      registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'completed', async () => {
        completedExecutions += 1;
        return completedExecutions;
      });
    expect(await completed()).toEqual({ ok: true, value: 1 });

    const gate = Promise.withResolvers<string>();
    let pendingExecutions = 0;
    const executePending = () => {
      pendingExecutions += 1;
      return gate.promise;
    };
    const pending = registry.run(
      ADMISSION_OPERATION_KIND.CREATE_ROOM,
      'pending',
      'same',
      executePending,
    );
    let duplicate: typeof pending | undefined;
    try {
      expect(
        await registry.run(
          ADMISSION_OPERATION_KIND.CREATE_ROOM,
          'new',
          'new',
          async () => 'new-token',
        ),
      ).toEqual({ ok: true, value: 'new-token' });
      duplicate = registry.run(
        ADMISSION_OPERATION_KIND.CREATE_ROOM,
        'pending',
        'same',
        executePending,
      );
      expect(duplicate).toBe(pending);
      expect(pendingExecutions).toBe(1);
      expect(await completed()).toEqual({ ok: true, value: 2 });
      expect(completedExecutions).toBe(2);

      gate.resolve('pending-token');
      expect(await pending).toEqual({ ok: true, value: 'pending-token' });
      expect(await duplicate).toEqual({ ok: true, value: 'pending-token' });
    } finally {
      gate.resolve('pending-token');
      await Promise.allSettled([pending, ...(duplicate === undefined ? [] : [duplicate])]);
    }
  });

  test('rejects new work when all capacity is pending and admits work after a completion', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 2,
      ttlMs: 100,
    });
    const firstGate = Promise.withResolvers<string>();
    const secondGate = Promise.withResolvers<string>();
    let pendingExecutions = 0;
    let newExecutions = 0;
    const executeFirst = () => {
      pendingExecutions += 1;
      return firstGate.promise;
    };
    const first = registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, 'first', 'same', executeFirst);
    const second = registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, 'second', 'same', () => {
      pendingExecutions += 1;
      return secondGate.promise;
    });
    const executeNew = async () => {
      newExecutions += 1;
      return 'new-token';
    };
    let duplicate: typeof first | undefined;
    try {
      expect(
        await registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, 'new', 'same', executeNew),
      ).toEqual({ ok: false, reason: ADMISSION_OPERATION_FAILURE.CAPACITY_EXCEEDED });
      expect(newExecutions).toBe(0);
      duplicate = registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, 'first', 'same', executeFirst);
      expect(duplicate).toBe(first);
      expect(pendingExecutions).toBe(2);
      expect(
        await registry.run(
          ADMISSION_OPERATION_KIND.CREATE_ROOM,
          'first',
          'different',
          executeFirst,
        ),
      ).toEqual({ ok: false, reason: ADMISSION_OPERATION_FAILURE.OPERATION_ID_REUSED });

      firstGate.resolve('first-token');
      expect(await first).toEqual({ ok: true, value: 'first-token' });
      expect(await duplicate).toEqual({ ok: true, value: 'first-token' });
      expect(
        await registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, 'new', 'same', executeNew),
      ).toEqual({ ok: true, value: 'new-token' });
      expect(newExecutions).toBe(1);
    } finally {
      firstGate.resolve('first-token');
      secondGate.resolve('second-token');
      await Promise.allSettled([first, second, ...(duplicate === undefined ? [] : [duplicate])]);
    }
  });

  test('executes the same operation again when its result is not retained', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 2,
      ttlMs: 100,
    });
    let executions = 0;
    const run = () =>
      registry.run(
        ADMISSION_OPERATION_KIND.JOIN_ROOM,
        OPERATION_ID,
        'same',
        async () => {
          executions += 1;
          return executions;
        },
        () => false,
      );

    expect(await run()).toEqual({ ok: true, value: 1 });
    expect(await run()).toEqual({ ok: true, value: 2 });
    expect(executions).toBe(2);
  });

  test('releases rejected pending work so the same operation can retry', async () => {
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => 1_000 },
      maxEntries: 2,
      ttlMs: 100,
    });
    const gate = Promise.withResolvers<string>();
    let executions = 0;
    const execute = () => {
      executions += 1;
      return executions === 1 ? gate.promise : Promise.resolve('retry-token');
    };
    const first = registry.run(ADMISSION_OPERATION_KIND.JOIN_ROOM, OPERATION_ID, 'same', execute);
    const duplicate = registry.run(
      ADMISSION_OPERATION_KIND.JOIN_ROOM,
      OPERATION_ID,
      'same',
      execute,
    );
    const outcomes = Promise.allSettled([first, duplicate]);
    const error = new Error('fixture admission failure');
    try {
      gate.reject(error);
      expect(await outcomes).toEqual([
        { status: 'rejected', reason: error },
        { status: 'rejected', reason: error },
      ]);
      expect(executions).toBe(1);
      expect(
        await registry.run(ADMISSION_OPERATION_KIND.JOIN_ROOM, OPERATION_ID, 'same', execute),
      ).toEqual({ ok: true, value: 'retry-token' });
      expect(executions).toBe(2);
    } finally {
      gate.resolve('released');
      await outcomes;
    }
  });

  test('keeps pending work past TTL and expires its result exactly one TTL after completion', async () => {
    let now = 1_000;
    let executions = 0;
    const registry = new AdmissionOperationRegistry({
      clock: { now: () => now },
      maxEntries: 2,
      ttlMs: 100,
    });
    const gate = Promise.withResolvers<string>();
    const execute = () => {
      executions += 1;
      return executions === 1 ? gate.promise : Promise.resolve('new-token');
    };
    const first = registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', execute);
    let duplicate: typeof first | undefined;
    try {
      await Promise.resolve();
      expect(executions).toBe(1);
      now = 2_000;
      duplicate = registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', execute);
      expect(duplicate).toBe(first);
      gate.resolve('original-token');
      expect(await first).toEqual({ ok: true, value: 'original-token' });
      expect(await duplicate).toEqual({ ok: true, value: 'original-token' });
      expect(executions).toBe(1);

      now = 2_099;
      expect(
        await registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', execute),
      ).toEqual({ ok: true, value: 'original-token' });
      expect(executions).toBe(1);
      now = 2_100;
      expect(
        await registry.run(ADMISSION_OPERATION_KIND.CREATE_ROOM, OPERATION_ID, 'same', execute),
      ).toEqual({ ok: true, value: 'new-token' });
      expect(executions).toBe(2);
    } finally {
      gate.resolve('released');
      await Promise.allSettled([first, ...(duplicate === undefined ? [] : [duplicate])]);
    }
  });
});
