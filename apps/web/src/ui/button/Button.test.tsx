// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { Button } from '@/ui/button/Button';

afterEach(cleanup);

test('blocks a locked action intent without changing its visual variant', () => {
  let intents = 0;
  render(<Button label='Roll' variant='primary' interactionLocked onClick={() => intents++} />);

  const action = screen.getByRole('button', { name: 'Roll' });
  fireEvent.click(action);

  expect(intents).toBe(0);
  expect(action.getAttribute('data-variant')).toBe('primary');
  expect(action.hasAttribute('disabled')).toBe(false);
});

test('emits one intent for an enabled standard action', () => {
  let intents = 0;
  render(<Button label='Roll' onClick={() => intents++} />);

  fireEvent.click(screen.getByRole('button', { name: 'Roll' }));

  expect(intents).toBe(1);
});

test('preserves the action name only when progress explicitly opts into an indicator', () => {
  const { rerender } = render(<Button label='Roll again' progress='…' />);
  expect(screen.getByRole('button', { name: '…' }).hasAttribute('aria-busy')).toBe(false);
  rerender(<Button label='Roll again' progress='…' preserveLabelOnProgress />);
  const action = screen.getByRole('button', { name: 'Roll again' });
  expect(action.getAttribute('aria-busy')).toBe('true');
  expect(within(action).getByText('…').getAttribute('aria-hidden')).toBe('true');
  rerender(<Button label='Roll again' preserveLabelOnProgress />);
  expect(action.hasAttribute('aria-busy')).toBe(false);
  expect(within(action).queryByText('…')).toBeNull();
});

test('reports an accepted pending action before its optional progress appears', () => {
  const { rerender } = render(
    <Button label='Roll again' busy interactionLocked preserveLabelOnProgress />,
  );
  const action = screen.getByRole('button', { name: 'Roll again' });
  expect(action.getAttribute('aria-busy')).toBe('true');
  expect(action.getAttribute('aria-disabled')).toBe('true');
  rerender(<Button label='Roll again' preserveLabelOnProgress />);
  expect(action.hasAttribute('aria-busy')).toBe(false);
});
