import { GAME_COMMAND_TYPE } from '@repo/game-protocol/socket';
import { describe, expect, test } from 'bun:test';

import { captureCommandTime } from '@/rooms/commands/command-time';
import { roomId } from '@/rooms/domain/room-model';
import { InMemoryRoomTaskQueue } from '@/rooms/scheduling/room-task-queue';

function quantumFixture(
  options: { maxRequestsPerRoom?: number; requestWaitTimeoutMs?: number } = {},
) {
  let now = 1_000;
  const scheduled = new Map<string, { runAt: number; task: () => void | Promise<void> }>();
  const queue = new InMemoryRoomTaskQueue({
    ...options,
    clock: { now: () => now },
    tasks: {
      schedule: (key, runAt, task) => {
        scheduled.set(key, { runAt, task });
      },
      cancel: (key) => {
        scheduled.delete(key);
      },
    },
  });
  return {
    queue,
    scheduled,
    advance: async (value: number) => {
      now = value;
      for (const [key, task] of [...scheduled]) {
        if (task.runAt <= now) {
          scheduled.delete(key);
          await task.task();
        }
      }
    },
  };
}

describe('in-memory room task queue', () => {
  test('keeps held forfeits within admission limits without blocking another room', async () => {
    const { queue, scheduled, advance } = quantumFixture({ maxRequestsPerRoom: 1 });
    const id = roomId('a');
    const order: string[] = [];
    const forfeit = queue.runRequest(
      id,
      () => order.push('forfeit'),
      captureCommandTime(GAME_COMMAND_TYPE.FORFEIT_MATCH, 1_000),
    );
    expect(await queue.runRequest(id, () => order.push('rejected'))).toEqual({
      ok: false,
      reason: 'capacity',
    });
    const lifecycle = queue.run(id, () => order.push('lifecycle'));
    expect(await queue.runRequest(roomId('b'), () => 42)).toEqual({ ok: true, value: 42 });
    expect(order).toEqual([]);
    expect(queue.pendingRequestCount).toBe(1);
    expect(scheduled.size).toBe(1);
    await advance(1_001);
    await Promise.all([forfeit, lifecycle]);
    expect(order).toEqual(['forfeit', 'lifecycle']);
    expect(queue.pendingRequestCount).toBe(0);
    expect(queue.activeRoomCount).toBe(0);
    expect(scheduled.size).toBe(0);
  });

  test('preserves gameplay FIFO ahead of a same-time forfeit and keeps later input behind it', async () => {
    const { queue, advance } = quantumFixture();
    const id = roomId('a');
    const order: string[] = [];
    const forfeit = queue.runRequest(
      id,
      () => order.push('forfeit'),
      captureCommandTime(GAME_COMMAND_TYPE.FORFEIT_MATCH, 1_000),
    );
    const roll = queue.runRequest(
      id,
      () => order.push('roll'),
      captureCommandTime(GAME_COMMAND_TYPE.ROLL_DICE, 1_000),
    );
    const score = queue.runRequest(
      id,
      () => order.push('score'),
      captureCommandTime(GAME_COMMAND_TYPE.SELECT_SCORE_CATEGORY, 1_000),
    );
    const later = queue.runRequest(
      id,
      () => order.push('later'),
      captureCommandTime(GAME_COMMAND_TYPE.ROLL_DICE, 1_001),
    );
    await advance(1_001);
    await Promise.all([forfeit, roll, score, later]);
    expect(order).toEqual(['roll', 'score', 'forfeit', 'later']);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('expires a held forfeit without executing or retaining its wakeup', async () => {
    const { queue, scheduled } = quantumFixture({ requestWaitTimeoutMs: 10 });
    let ran = false;
    const result = await queue.runRequest(
      roomId('a'),
      () => {
        ran = true;
      },
      captureCommandTime(GAME_COMMAND_TYPE.FORFEIT_MATCH, 1_000),
    );
    expect(result).toEqual({ ok: false, reason: 'waitExpired' });
    expect(ran).toBeFalse();
    expect(queue.pendingRequestCount).toBe(0);
    expect(queue.activeRoomCount).toBe(0);
    expect(scheduled.size).toBe(0);
    expect(await queue.runRequest(roomId('a'), () => 42)).toEqual({ ok: true, value: 42 });
  });

  test.each(['clearRoom', 'close'] as const)(
    '%s releases held requests and makes stale wakeups harmless',
    async (operation) => {
      const { queue, scheduled } = quantumFixture();
      const id = roomId('a');
      let ran = false;
      const held = queue.runRequest(
        id,
        () => {
          ran = true;
        },
        captureCommandTime(GAME_COMMAND_TYPE.FORFEIT_MATCH, 1_000),
      );
      const stale = scheduled.values().next().value;
      if (stale === undefined) throw new Error('wake missing');
      queue[operation](id);
      expect(await held).toEqual({ ok: false, reason: 'closed' });
      expect(ran).toBeFalse();
      expect(queue.pendingRequestCount).toBe(0);
      expect(queue.activeRoomCount).toBe(0);
      expect(scheduled.size).toBe(0);
      expect(await queue.runRequest(id, () => 42)).toEqual(
        operation === 'close' ? { ok: false, reason: 'closed' } : { ok: true, value: 42 },
      );
      await stale.task();
      expect(ran).toBeFalse();
      expect(queue.activeRoomCount).toBe(0);
    },
  );

  test('close cancels queued requests while letting running work and lifecycle work finish', async () => {
    const queue = new InMemoryRoomTaskQueue();
    const id = roomId('a');
    const gate = Promise.withResolvers<number>();
    const running = queue.runRequest(id, () => gate.promise);
    let queuedRan = false;
    const queued = queue.runRequest(id, () => {
      queuedRan = true;
    });
    const lifecycle = queue.run(id, () => 7);
    queue.close();
    expect(await queued).toEqual({ ok: false, reason: 'closed' });
    expect(queue.pendingRequestCount).toBe(1);
    gate.resolve(42);
    expect(await running).toEqual({ ok: true, value: 42 });
    expect(await lifecycle).toBe(7);
    expect(queuedRan).toBeFalse();
    expect(queue.pendingRequestCount).toBe(0);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('bounds total requests across rooms and admits after completion', async () => {
    const queue = new InMemoryRoomTaskQueue({ maxRequests: 2 });
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    const first = queue.runRequest(roomId('a'), () => firstGate.promise);
    const second = queue.runRequest(roomId('b'), () => secondGate.promise);
    try {
      expect(await queue.runRequest(roomId('c'), () => 1)).toEqual({
        ok: false,
        reason: 'capacity',
      });
      firstGate.resolve();
      await first;
      expect(await queue.runRequest(roomId('c'), () => 2)).toEqual({ ok: true, value: 2 });
    } finally {
      firstGate.resolve();
      secondGate.resolve();
      await Promise.all([first, second]);
    }
    expect(queue.pendingRequestCount).toBe(0);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('serializes the same room and allows different rooms to proceed', async () => {
    const queue = new InMemoryRoomTaskQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run(roomId('room-a'), async () => {
      order.push('a1:start');
      await gate;
      order.push('a1:end');
    });
    const second = queue.run(roomId('room-a'), () => {
      order.push('a2');
    });
    const other = queue.run(roomId('room-b'), () => {
      order.push('b1');
    });

    await other;
    expect(order).toEqual(['a1:start', 'b1']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['a1:start', 'b1', 'a1:end', 'a2']);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('continues after a failed operation and releases the room', async () => {
    const queue = new InMemoryRoomTaskQueue();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.run(roomId('room-a'), async () => {
      await gate;
      throw new Error('expected fixture failure');
    });
    const second = queue.run(roomId('room-a'), () => 42);
    releaseFirst();
    await expect(first).rejects.toThrow('expected fixture failure');
    await expect(second).resolves.toBe(42);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('rejects excess requests without effects and still admits lifecycle work in FIFO order', async () => {
    const queue = new InMemoryRoomTaskQueue({ maxRequestsPerRoom: 2 });
    const gate = Promise.withResolvers<void>();
    const order: string[] = [];
    const id = roomId('room-a');
    const first = queue.runRequest(id, async () => {
      await gate.promise;
      order.push('first');
      return 1;
    });
    const second = queue.runRequest(id, () => order.push('second'));
    const rejected = await queue.runRequest(id, () => order.push('rejected'));
    const cleanup = queue.run(id, () => order.push('cleanup'));
    expect(rejected).toEqual({ ok: false, reason: 'capacity' });
    expect(queue.pendingRequestCount).toBe(2);
    gate.resolve();
    expect(await first).toEqual({ ok: true, value: 1 });
    await Promise.all([second, cleanup]);
    expect(order).toEqual(['first', 'second', 'cleanup']);
    expect(queue.pendingRequestCount).toBe(0);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('expires waiting requests, releases their capacity, and never cancels a running request', async () => {
    const queue = new InMemoryRoomTaskQueue({ maxRequestsPerRoom: 2, requestWaitTimeoutMs: 10 });
    const gate = Promise.withResolvers<void>();
    const id = roomId('room-a');
    let expiredRan = false;
    const first = queue.runRequest(id, () => gate.promise);
    const expired = queue.runRequest(id, () => {
      expiredRan = true;
    });
    expect(await expired).toEqual({ ok: false, reason: 'waitExpired' });
    expect(queue.pendingRequestCount).toBe(1);
    const next = queue.runRequest(id, () => 42);
    gate.resolve();
    expect(await first).toEqual({ ok: true, value: undefined });
    expect(await next).toEqual({ ok: true, value: 42 });
    expect(expiredRan).toBe(false);
    expect(queue.activeRoomCount).toBe(0);
  });

  test('releases a failed request before admitting its replacement', async () => {
    const queue = new InMemoryRoomTaskQueue({ maxRequestsPerRoom: 1 });
    const id = roomId('room-a');
    await expect(
      queue.runRequest(id, () => {
        throw new Error('expected fixture failure');
      }),
    ).rejects.toThrow('expected fixture failure');
    expect(await queue.runRequest(id, () => 42)).toEqual({ ok: true, value: 42 });
    expect(queue.pendingRequestCount).toBe(0);
  });
});
