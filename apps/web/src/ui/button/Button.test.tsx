// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
