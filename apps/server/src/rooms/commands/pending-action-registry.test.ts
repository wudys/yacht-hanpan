import { describe, expect, test } from 'bun:test';

import {
  MAX_PENDING_ACTIONS_PER_ROOM,
  PendingActionRegistry,
  type PendingActionRunResult,
} from '@/rooms/commands/pending-action-registry';

describe('pending action registry', () => {
  test('registers the owner before a reentrant duplicate and invokes it only once', async () => {
    const registry = new PendingActionRegistry<number>();
    const gate = Promise.withResolvers<number>();
    let duplicate: Promise<PendingActionRunResult<number>> | undefined;
    const owner = registry.run('room', 'seat:action', 'same', () => {
      duplicate = registry.run('room', 'seat:action', 'same', () => {
        throw new Error('duplicate executed');
      });
      return gate.promise;
    });
    gate.resolve(42);
    expect(await owner).toEqual({ kind: 'result', owner: true, result: 42 });
    expect(await duplicate).toEqual({ kind: 'result', owner: false, result: 42 });
    expect(registry.totalCount()).toBe(0);
  });

  test('releases identity after an owner throws synchronously', async () => {
    const registry = new PendingActionRegistry<number>();
    await expect(
      registry.run('room', 'seat:action', 'same', () => {
        throw new Error('fixture failure');
      }),
    ).rejects.toThrow('fixture failure');
    expect(registry.totalCount()).toBe(0);
    expect(await registry.run('room', 'seat:action', 'same', async () => 42)).toEqual({
      kind: 'result',
      owner: true,
      result: 42,
    });
  });

  test('bounds duplicate waiters even across disconnected transports', async () => {
    const pending = new PendingActionRegistry<number>();
    const gate = Promise.withResolvers<number>();
    const waiting = Array.from({ length: 8 }, () =>
      pending.run('room', 'seat:action', 'same', () => gate.promise),
    );
    try {
      expect(await pending.run('room', 'seat:action', 'same', () => gate.promise)).toEqual({
        kind: 'saturated',
      });
    } finally {
      gate.resolve(42);
      await Promise.all(waiting);
    }
    expect(await pending.run('room', 'seat:action', 'same', async () => 43)).toEqual({
      kind: 'result',
      owner: true,
      result: 43,
    });
    expect(pending.totalCount()).toBe(0);
  });

  test('coalesces identical pending work and rejects conflicting reuse', async () => {
    const registry = new PendingActionRegistry<number>();
    let completeExecution!: (value: number) => void;
    let calls = 0;
    const execution = () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        completeExecution = resolve;
      });
    };
    const owner = registry.run('room', 'seat:action', 'same', execution);
    await Promise.resolve();
    const duplicate = registry.run('room', 'seat:action', 'same', execution);
    expect(registry.totalCount()).toBe(1);
    expect(await registry.run('room', 'seat:action', 'different', execution)).toEqual({
      kind: 'conflict',
    });
    expect(calls).toBe(1);
    completeExecution(7);
    expect(await owner).toEqual({ kind: 'result', owner: true, result: 7 });
    expect(await duplicate).toEqual({ kind: 'result', owner: false, result: 7 });
    expect(registry.count('room')).toBe(0);
    expect(registry.totalCount()).toBe(0);
  });

  test('fails closed at the in-flight action bound', async () => {
    const pending = new PendingActionRegistry<number>();
    const never = () => new Promise<number>(() => undefined);
    for (let index = 0; index < MAX_PENDING_ACTIONS_PER_ROOM; index += 1) {
      void pending.run('room', `seat:action-${index}`, String(index), never);
    }
    await Promise.resolve();
    expect(pending.count('room')).toBe(MAX_PENDING_ACTIONS_PER_ROOM);
    expect(pending.totalCount()).toBe(MAX_PENDING_ACTIONS_PER_ROOM);
    expect(await pending.run('room', 'seat:overflow', 'overflow', never)).toEqual({
      kind: 'saturated',
    });
  });

  test('clears in-flight actions owned by a removed room', async () => {
    const pending = new PendingActionRegistry<number>();
    void pending.run(
      'removed-room',
      'seat:action',
      'fingerprint',
      () => new Promise<number>(() => undefined),
    );
    await Promise.resolve();

    pending.clearRoom('removed-room');

    expect(pending.count('removed-room')).toBe(0);
    expect(pending.totalCount()).toBe(0);
  });

  test('preserves replacement work when a cleared action finishes later', async () => {
    const pending = new PendingActionRegistry<number>();
    let finishOld!: (value: number) => void;
    let finishNew!: (value: number) => void;
    const oldExecution = new Promise<number>((resolve) => {
      finishOld = resolve;
    });
    const newExecution = new Promise<number>((resolve) => {
      finishNew = resolve;
    });
    let newCalls = 0;
    const executeNew = () => {
      newCalls += 1;
      return newExecution;
    };
    const oldOwner = pending.run('room', 'seat:action', 'old', () => oldExecution);
    await Promise.resolve();
    pending.clearRoom('room');
    const newOwner = pending.run('room', 'seat:action', 'new', executeNew);
    await Promise.resolve();

    finishOld(1);
    await oldOwner;
    const countAfterOldCompletion = pending.count('room');
    const duplicate = pending.run('room', 'seat:action', 'new', executeNew);
    finishNew(2);
    const ownerResult = await newOwner;
    const duplicateResult = await duplicate;

    expect(countAfterOldCompletion).toBe(1);
    expect(newCalls).toBe(1);
    expect(ownerResult).toEqual({ kind: 'result', owner: true, result: 2 });
    expect(duplicateResult).toEqual({ kind: 'result', owner: false, result: 2 });
    expect(pending.totalCount()).toBe(0);
  });
});
