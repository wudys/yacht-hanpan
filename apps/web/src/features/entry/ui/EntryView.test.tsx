// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test } from 'vitest';

import { EntryView } from '@/features/entry/ui/EntryView';

afterEach(cleanup);

test('renders the product brand, a screen-reader title, and one start action', () => {
  const view = renderToStaticMarkup(
    <EntryView title='Start Hanpan' startLabel='Start game' pending={false} onStart={() => {}} />,
  );

  expect(view).toContain('<h1 class="entry-view__title">Start Hanpan</h1>');
  expect(view.match(/<button/g)).toHaveLength(1);
  expect(view).toContain('>Start game<');
  expect(view).not.toContain('role="alert"');
});

test('accepts only a primary pointer-generated click and locks duplicate pending intent', () => {
  const intents: string[] = [];
  const { rerender } = render(
    <EntryView
      title='Start Hanpan'
      startLabel='Start game'
      pending={false}
      onStart={() => intents.push('start')}
    />,
  );
  const button = screen.getByRole('button', { name: 'Start game' });
  expect(button.tabIndex).toBe(-1);

  fireEvent.click(button, { detail: 0, button: 0 });
  fireEvent.click(button, { detail: 1, button: 2 });
  fireEvent.click(button, { detail: 1, button: 0 });
  expect(intents).toEqual(['start']);

  rerender(
    <EntryView
      title='Start Hanpan'
      startLabel='Start game'
      pending
      onStart={() => intents.push('duplicate')}
    />,
  );
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(button, { detail: 1, button: 0 });
  expect(intents).toEqual(['start']);
});

test('keeps the same start action with an inline activation failure', () => {
  const view = renderToStaticMarkup(
    <EntryView
      title='Start Hanpan'
      startLabel='Start game'
      activationFailure='Could not start. Please try again.'
      pending={false}
      onStart={() => {}}
    />,
  );

  expect(view).toContain('role="alert"');
  expect(view).toContain('Could not start. Please try again.');
  expect(view.match(/<button/g)).toHaveLength(1);
  expect(view).toContain('>Start game<');
});
