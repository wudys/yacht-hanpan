// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- Vitest globals are disabled; register cleanup explicitly. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';

import { SettingsView, type SettingsViewProps } from '@/features/settings/ui/SettingsView';

afterEach(cleanup);

const labels = {
  title: 'Settings title',
  close: 'Close settings',
  locale: 'Language',
  korean: 'Korean',
  english: 'English',
  bgm: 'Background music',
  sfx: 'Effects',
  storageFailure: 'Storage unavailable',
} as const;

const baseProps = {
  labels,
  locale: 'ko',
  bgmEnabled: true,
  sfxEnabled: false,
  onClose: () => undefined,
  onLocaleChange: () => undefined,
  onBgmChange: () => undefined,
  onSfxChange: () => undefined,
} as const satisfies SettingsViewProps;

test('exposes current preferences and a storage failure without a Lobby forfeit action', () => {
  render(<SettingsView {...baseProps} storageFailed />);

  expect(screen.getByRole('button', { name: labels.korean, pressed: true })).toBeTruthy();
  expect(screen.getByRole('button', { name: labels.english, pressed: false })).toBeTruthy();
  expect(screen.getByRole('switch', { name: labels.bgm, checked: true })).toBeTruthy();
  expect(screen.getByRole('switch', { name: labels.sfx, checked: false })).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe(labels.storageFailure);
  expect(screen.queryByRole('button', { name: 'Forfeit' })).toBeNull();
});

test('emits locale and sound changes from the rendered controls', () => {
  const intents: string[] = [];
  render(
    <SettingsView
      {...baseProps}
      onLocaleChange={(locale) => intents.push(locale)}
      onBgmChange={(enabled) => intents.push(`bgm:${enabled}`)}
      onSfxChange={(enabled) => intents.push(`sfx:${enabled}`)}
    />,
  );

  fireEvent.click(screen.getByRole('button', { name: labels.english }));
  fireEvent.click(screen.getByRole('switch', { name: labels.bgm }));
  fireEvent.click(screen.getByRole('switch', { name: labels.sfx }));

  expect(intents).toEqual(['en', 'bgm:false', 'sfx:true']);
});

test.each([false, true])('gates the Game forfeit action when disabled=%s', (disabled) => {
  const intents: string[] = [];
  render(
    <SettingsView
      {...baseProps}
      forfeit={{
        label: 'Forfeit',
        description: 'Leave this match',
        disabled,
        onIntent: () => intents.push('forfeit'),
      }}
    />,
  );

  const action = screen.getByRole('button', { name: 'Forfeit' });
  expect(action.hasAttribute('disabled')).toBe(disabled);
  fireEvent.click(action);
  expect(intents).toEqual(disabled ? [] : ['forfeit']);
});
