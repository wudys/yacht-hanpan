// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled, so parameterized renders need explicit cleanup. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Fragment, StrictMode } from 'react';
import { afterEach, expect, it } from 'vitest';

import { PrivacyDialog } from '@/features/privacy/PrivacyDialog';

afterEach(cleanup);

it.each([false, true])(
  'opens the notice and closes after confirmation with StrictMode=%s',
  (strict) => {
    const Mode = strict ? StrictMode : Fragment;
    render(
      <Mode>
        <div className='game-logical-canvas'>
          <PrivacyDialog locale='en'>{(privacyLink) => privacyLink}</PrivacyDialog>
        </div>
      </Mode>,
    );
    const trigger = screen.getByRole('button', { name: 'Privacy Policy' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Privacy Policy' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  },
);
