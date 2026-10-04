import { expect, test } from 'bun:test';

import { closeGameServerResources } from '@/app/close-game-server-resources';

test('cleanup preserves every failure in disposal order and continues to the worker', async () => {
  const first = new Error('telemetry');
  const second = new Error('rooms');
  const order: string[] = [];
  let caught: unknown;
  try {
    await closeGameServerResources({
      telemetry: {
        close() {
          order.push('telemetry');
          throw first;
        },
      },
      rooms: {
        close() {
          order.push('rooms');
          throw second;
        },
      },
      socketServer: {
        async close() {
          order.push('socket');
        },
      },
      rollSimulation: {
        async close() {
          order.push('worker');
        },
      },
    });
  } catch (error) {
    caught = error;
  }
  expect(order).toEqual(['telemetry', 'rooms', 'socket', 'worker']);
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([first, second]);
});
