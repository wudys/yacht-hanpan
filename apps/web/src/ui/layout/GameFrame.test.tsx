// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { GameFrame } from '@/ui/layout/GameFrame';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test('blocks measured coarse landscape input on initial render and restores portrait', async () => {
  const matchMedia = vi.fn(() => ({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(844);
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(390);
  const onOrientationGuardExit = vi.fn();
  render(
    <GameFrame orientationMessage='Use portrait' onOrientationGuardExit={onOrientationGuardExit}>
      <button type='button'>Game input</button>
    </GameFrame>,
  );

  expect(matchMedia).toHaveBeenCalledWith('(pointer: coarse)');
  expect(screen.getByRole('status').textContent).toBe('Use portrait');
  // eslint-disable-next-line testing-library/no-node-access -- the frame slot owns the input guard around the rendered control.
  const slot = screen.getByText('Game input').closest('[data-game-frame-slot]');
  expect(slot?.getAttribute('inert')).toBe('');
  expect(slot?.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Game input' })).toBeNull();
  expect(onOrientationGuardExit).not.toHaveBeenCalled();

  width.mockReturnValue(390);
  height.mockReturnValue(844);
  await act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.queryByRole('status')).toBeNull();
  expect(slot?.hasAttribute('inert')).toBe(false);
  expect(slot?.hasAttribute('aria-hidden')).toBe(false);
  expect(screen.getByRole('button', { name: 'Game input' })).not.toBeNull();
  expect(onOrientationGuardExit).toHaveBeenCalledOnce();
});
