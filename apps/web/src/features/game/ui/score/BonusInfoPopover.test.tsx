// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, test } from 'vitest';

import {
  BonusInfoPopover,
  type BonusInfoPopoverProps,
} from '@/features/game/ui/score/BonusInfoPopover';

afterEach(cleanup);

const props = {
  subtotal: 0,
  labels: {
    title: 'Bonus details',
    upperRange: 'Upper category range',
    subtotal: 'Current subtotal',
    close: 'Close bonus details',
  },
  onClose: () => undefined,
} as const satisfies BonusInfoPopoverProps;

test('renders a named bonus dialog with current progress and award', () => {
  const view = renderToStaticMarkup(<BonusInfoPopover {...props} />);

  expect(view).toContain('role="dialog"');
  expect(view).toContain('aria-label="Bonus details"');
  expect(view).toContain('data-bonus-subtotal="0"');
  expect(view).toContain('data-bonus-threshold="63"');
  expect(view).toContain('data-bonus-award="35"');
  expect(view).toContain('>0/63<');
  expect(view).toContain('aria-label="Upper category range"');
  expect(view).toContain('+35');
});

test('emits only the explicit close intent from its close action', () => {
  let closeCount = 0;
  render(<BonusInfoPopover {...props} onClose={() => closeCount++} />);

  fireEvent.click(screen.getByRole('button', { name: props.labels.close }));

  expect(closeCount).toBe(1);
});

test.each([62, 63, 68])(
  'shows the actual subtotal %i without capping progress at the threshold',
  (subtotal) => {
    render(<BonusInfoPopover {...props} subtotal={subtotal} />);
    expect(screen.getByText(`${subtotal}/63`)).toBeTruthy();
    expect(screen.getByText('+35')).toBeTruthy();
  },
);
