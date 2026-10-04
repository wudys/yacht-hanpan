import { expect, test } from 'bun:test';

import { createServerClock } from './server-clock';

test('uses RTT and monotonic elapsed time, ignoring older responses', () => {
  let monotonic = 10;
  const clock = createServerClock(() => monotonic);
  expect(clock.now()).toBeNull();
  const old = clock.beginSample();
  monotonic = 20;
  const current = clock.beginSample();
  monotonic = 60;
  clock.acceptSample(current, 1_000);
  expect(clock.now()).toBe(1_020);
  monotonic = 100;
  clock.acceptSample(old, 900);
  expect(clock.now()).toBe(1_060);
});
