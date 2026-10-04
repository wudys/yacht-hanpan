import { expect, test, vi } from 'vitest';

import { createTurnWarning } from '@/runtime/audio/turn-warning';
test('warns only on new eligible second boundaries, never on restoration or catch-up', () => {
  const play = vi.fn(),
    stop = vi.fn(),
    warning = createTurnWarning(play, stop);
  warning.update('turn1', 5, true);
  expect(play).not.toHaveBeenCalled();
  warning.update('turn1', 4, true);
  warning.update('turn1', 4, true);
  expect(play).toHaveBeenCalledTimes(1);
  warning.update('turn1', 3, false);
  warning.update('turn1', 3, true);
  expect(play).toHaveBeenCalledTimes(1);
  warning.update('turn1', 1, true);
  expect(play).toHaveBeenCalledTimes(2);
  warning.update('turn1', 2, true);
  warning.update('turn1', 1, true);
  warning.update('turn1', 0, true);
  expect(play).toHaveBeenCalledTimes(2);
  warning.update('opponent', 4, false);
  warning.update('opponent', 3, false);
  expect(play).toHaveBeenCalledTimes(2);
  warning.update('turn2', 10, true);
  warning.update('turn2', 5, true);
  expect(play).toHaveBeenCalledTimes(3);
  warning.update(null, null, false);
  expect(stop).toHaveBeenCalled();
});

test('normal own-turn countdown emits exactly five warnings and stops at zero', () => {
  const play = vi.fn(),
    stop = vi.fn(),
    warning = createTurnWarning(play, stop);
  warning.update('own', 6, true);
  for (const second of [5, 4, 3, 2, 1, 0]) {
    warning.update('own', second, true);
    warning.update('own', second, true);
  }
  expect(play).toHaveBeenCalledTimes(5);
});

test('the first restored clock sample is silent and only its next boundary warns', () => {
  const play = vi.fn(),
    warning = createTurnWarning(play, vi.fn());
  warning.update('restored', null, true);
  warning.update('restored', 4, true);
  expect(play).not.toHaveBeenCalled();
  warning.update('restored', 3, true);
  expect(play).toHaveBeenCalledTimes(1);
});
