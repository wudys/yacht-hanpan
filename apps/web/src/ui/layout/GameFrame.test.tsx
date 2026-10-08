// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

import { type FrameAvailability, GameFrame } from '@/ui/layout/GameFrame';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function FrameProbe({
  availability,
  observe,
  mounted,
}: Readonly<{
  availability: FrameAvailability;
  observe: (
    availability: FrameAvailability,
    blocked: boolean,
    hidden: boolean,
    messageVisible: boolean,
  ) => void;
  mounted: () => void;
}>) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(mounted, [mounted]);
  useLayoutEffect(() => {
    // eslint-disable-next-line testing-library/no-node-access -- observes the guard enclosing this committed consumer.
    const slot = input.current?.closest('[data-game-frame-slot]');
    observe(
      availability,
      slot?.hasAttribute('inert') ?? false,
      slot?.getAttribute('aria-hidden') === 'true',
      screen.queryByRole('status') !== null,
    );
  }, [availability, observe]);
  return <input ref={input} aria-label='Persistent input' defaultValue='Room code' />;
}

test('blocks a short fine-pointer window and restores input when the landscape window grows', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(844);
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(390);
  render(
    <GameFrame playAreaMessage='Not enough room to play.'>
      <button type='button'>Game input</button>
    </GameFrame>,
  );

  expect(screen.getByRole('status').textContent).toBe('Not enough room to play.');
  // eslint-disable-next-line testing-library/no-node-access -- the slot owns the native input guard.
  const slot = screen.getByText('Game input').closest('[data-game-frame-slot]');
  expect(slot?.getAttribute('inert')).toBe('');
  expect(slot?.getAttribute('aria-hidden')).toBe('true');
  expect(screen.queryByRole('button', { name: 'Game input' })).toBeNull();

  width.mockReturnValue(900);
  height.mockReturnValue(600);
  await act(() => window.dispatchEvent(new Event('resize')));
  expect(screen.queryByRole('status')).toBeNull();
  expect(slot?.hasAttribute('inert')).toBe(false);
  expect(slot?.hasAttribute('aria-hidden')).toBe(false);
  expect(screen.getByRole('button', { name: 'Game input' })).not.toBeNull();
});

test('allows a roomy coarse-pointer landscape without a portrait requirement', () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: true })),
  );
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(768);
  render(
    <GameFrame playAreaMessage='Not enough room to play.'>
      <button type='button'>Game input</button>
    </GameFrame>,
  );

  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'Game input' })).not.toBeNull();
});

test('supplies availability with the same committed native guard and preserves the mounted child', async () => {
  const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  const observe = vi.fn();
  const mounted = vi.fn();
  render(
    <GameFrame playAreaMessage='Not enough room to play.'>
      {(availability) => (
        <FrameProbe availability={availability} observe={observe} mounted={mounted} />
      )}
    </GameFrame>,
  );

  expect(observe.mock.calls).toEqual([
    ['unmeasured', true, true, false],
    ['available', false, false, false],
  ]);
  const input = screen.getByRole('textbox', { name: 'Persistent input' });
  fireEvent.change(input, { target: { value: '1234' } });
  (input as HTMLInputElement).setSelectionRange(2, 2);
  expect(mounted).toHaveBeenCalledOnce();

  width.mockReturnValue(319);
  height.mockReturnValue(900);
  await act(() => window.dispatchEvent(new Event('resize')));
  expect(observe).toHaveBeenLastCalledWith('insufficient-space', true, true, true);
  expect(screen.queryByRole('textbox', { name: 'Persistent input' })).toBeNull();
  expect(screen.getByLabelText('Persistent input')).toBe(input);

  width.mockReturnValue(390);
  await act(() => window.dispatchEvent(new Event('resize')));
  expect(observe).toHaveBeenLastCalledWith('available', false, false, false);
  expect(screen.getByRole('textbox', { name: 'Persistent input' })).toBe(input);
  expect((input as HTMLInputElement).value).toBe('1234');
  expect((input as HTMLInputElement).selectionStart).toBe(2);
  expect(mounted).toHaveBeenCalledOnce();
});

test('uses measured safe-area padding to guard an otherwise sufficient wrapper', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  const padding = vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    paddingTop: '28px',
    paddingRight: '20px',
    paddingBottom: '28px',
    paddingLeft: '20px',
  } as CSSStyleDeclaration);
  const availability = vi.fn(() => <span>Game surface</span>);
  render(<GameFrame playAreaMessage='Not enough room to play.'>{availability}</GameFrame>);

  expect(availability).toHaveBeenLastCalledWith('insufficient-space');
  expect(screen.getByRole('status').textContent).toBe('Not enough room to play.');

  padding.mockReturnValue({
    paddingTop: '20px',
    paddingRight: '20px',
    paddingBottom: '20px',
    paddingLeft: '20px',
  } as CSSStyleDeclaration);
  await act(() => window.dispatchEvent(new Event('resize')));
  expect(availability).toHaveBeenLastCalledWith('available');
  expect(screen.queryByRole('status')).toBeNull();
});

test('updates availability through ResizeObserver and disconnects its measurement subscription', async () => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(500);
  let update: (() => void) | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      public constructor(callback: () => void) {
        update = callback;
      }
      public observe() {}
      public readonly disconnect: () => void = disconnect;
    },
  );
  const { unmount } = render(
    <GameFrame playAreaMessage='Not enough room to play.'>
      <button type='button'>Game input</button>
    </GameFrame>,
  );
  expect(screen.getByRole('button', { name: 'Game input' })).not.toBeNull();

  height.mockReturnValue(444);
  await act(() => update?.());
  expect(screen.getByRole('status').textContent).toBe('Not enough room to play.');
  expect(screen.queryByRole('button', { name: 'Game input' })).toBeNull();
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
});
