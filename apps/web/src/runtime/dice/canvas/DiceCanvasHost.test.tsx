// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import DiceCanvasHost from '@/runtime/dice/canvas/DiceCanvasHost';
import {
  createRendererReadiness as createReadiness,
  type RendererReadiness,
} from '@/runtime/dice/canvas/renderer-readiness';
import type { DicePresentationView } from '@/runtime/dice/dice-presentation';
import { PersistentDiceCanvas } from '@/runtime/dice/PersistentDiceCanvas';

const { configure, renderCanvas, unmountCanvas } = vi.hoisted(() => ({
  configure: vi.fn(async () => {}),
  renderCanvas: vi.fn(),
  unmountCanvas: vi.fn(),
}));

vi.mock('@react-three/fiber', () => ({
  createRoot: () => ({ configure, render: renderCanvas, unmount: unmountCanvas }),
  extend: () => {},
  flushSync: (cleanup: () => void) => cleanup(),
  useThree: () => ({ gl: {}, scene: {}, camera: {} }),
}));

vi.mock('@/runtime/dice/renderer', () => ({
  DiceWarmupScene: () => null,
}));

const hiddenPresentationSnapshot = { phase: 'hidden', resources: null } as const;
const presentation = {
  getSnapshot: () => hiddenPresentationSnapshot,
  subscribe: () => () => {},
  completePlayback: vi.fn(),
} satisfies DicePresentationView;

async function readyState() {
  const readiness = createReadiness();
  const prepared = readiness.prepare();
  await readiness.run(readiness.getSnapshot().attempt, async () => {});
  await prepared;
  return readiness;
}

test('unmounts the failed canvas root while preserving the terminal renderer failure', async () => {
  unmountCanvas.mockClear();
  const readiness = await readyState();
  const view = render(<PersistentDiceCanvas presentation={presentation} renderer={readiness} />);
  try {
    const canvas = await screen.findByTestId('dice-canvas');

    act(() => {
      canvas.dispatchEvent(new Event('webglcontextlost'));
    });

    expect(readiness.getSnapshot()).toEqual({ status: 'runtimeFailed', attempt: 1 });
    expect(screen.queryByTestId('dice-canvas')).toBeNull();
    expect(unmountCanvas).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
  }
  expect(unmountCanvas).toHaveBeenCalledOnce();
});

test('detaches stale-attempt and unmounted canvas context-loss listeners', () => {
  let snapshot = { status: 'ready' as const, attempt: 1 };
  const subscribers = new Set<() => void>();
  const fail = vi.fn();
  const readiness = {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    fail,
  } as unknown as RendererReadiness;
  const view = render(<DiceCanvasHost presentation={presentation} renderer={readiness} />);
  const canvas = screen.getByTestId('dice-canvas');

  act(() => {
    snapshot = { status: 'ready', attempt: 2 };
    subscribers.forEach((subscriber) => subscriber());
  });
  act(() => {
    canvas.dispatchEvent(new Event('webglcontextlost'));
  });
  expect(fail).toHaveBeenCalledTimes(1);
  expect(fail).toHaveBeenCalledWith(2, expect.any(Event));

  view.unmount();
  canvas.dispatchEvent(new Event('webglcontextlost'));
  expect(fail).toHaveBeenCalledTimes(1);
});
