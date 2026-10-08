// @vitest-environment jsdom

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { DicePresentationScene } from '@/runtime/dice/canvas/DicePresentationScene';
import type {
  DicePresentationRenderPort,
  DicePresentationSnapshot,
} from '@/runtime/dice/dice-presentation-controller';
import type { RollPlayback } from '@/runtime/dice/replay';
import type { ProceduralDiceResources } from '@/runtime/dice/resources';

const { invalidate, setFrameloop } = vi.hoisted(() => ({
  invalidate: vi.fn(),
  setFrameloop: vi.fn(),
}));

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ invalidate, setFrameloop }),
}));

vi.mock('@/runtime/dice/renderer', () => ({
  DiceRollScene: ({
    onComplete,
    playback,
  }: {
    onComplete?: (rollId: string) => void;
    playback: RollPlayback;
  }) => (
    <button
      type='button'
      onClick={() => {
        if (playback.status === 'verified') onComplete?.(playback.rollId);
      }}
    >
      rolling
    </button>
  ),
  DiceSettledScene: () => <div>settled</div>,
}));

afterEach(() => {
  invalidate.mockReset();
  setFrameloop.mockReset();
});

test('runs frames only for verified playback and renders all static states on demand', () => {
  const resources = {} as ProceduralDiceResources;
  let snapshot: DicePresentationSnapshot = { phase: 'hidden', resources };
  const listeners = new Set<() => void>();
  const completePlayback = vi.fn();
  const presentation = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    completePlayback,
    publish(next: DicePresentationSnapshot) {
      snapshot = next;
      listeners.forEach((listener) => listener());
    },
  } satisfies DicePresentationRenderPort & { publish(next: DicePresentationSnapshot): void };
  render(<DicePresentationScene presentation={presentation} />);
  expect(setFrameloop).toHaveBeenLastCalledWith('demand');
  expect(invalidate).toHaveBeenCalledTimes(1);

  act(() => {
    presentation.publish({ phase: 'settled', resources, dice: [{ slot: 0, value: 1 }] });
  });
  expect(screen.getByText('settled')).not.toBeNull();
  expect(setFrameloop).toHaveBeenLastCalledWith('demand');

  act(() => {
    presentation.publish({
      phase: 'rolling',
      resources,
      rollId: 'verified-roll',
      dice: [],
      playback: {
        status: 'verified',
        rollId: 'verified-roll',
        timeline: { rollId: 'verified-roll' },
      } as RollPlayback,
    });
  });
  expect(setFrameloop).toHaveBeenLastCalledWith('always');
  fireEvent.click(screen.getByRole('button', { name: 'rolling' }));
  expect(completePlayback).toHaveBeenCalledWith('verified-roll');
  completePlayback.mockClear();

  act(() => {
    presentation.publish({
      phase: 'rolling',
      resources,
      rollId: 'fallback-roll',
      dice: [],
      playback: {
        status: 'static-fallback',
        rollId: 'fallback-roll',
        reason: 'OUTCOME_MISMATCH',
        dice: [],
      },
    });
  });
  expect(setFrameloop).toHaveBeenLastCalledWith('demand');
  expect(invalidate).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getByRole('button', { name: 'rolling' }));
  expect(completePlayback).not.toHaveBeenCalled();
});
