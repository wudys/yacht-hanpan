// @vitest-environment jsdom
/* eslint-disable testing-library/no-manual-cleanup -- SettingsLayer stays mounted through each preference assertion. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import { SettingsLayer } from '@/features/settings/SettingsLayer';
import { createProductPreferences } from '@/runtime/preferences/product-preferences';

afterEach(cleanup);

test('keeps failed storage changes selected and reports one inline warning', () => {
  const preferences = createProductPreferences({
    getItem: () => null,
    setItem: () => {
      throw new Error('storage blocked');
    },
  });
  preferences.setLocale('en');
  const { rerender } = render(
    <SettingsLayer
      audio={{ playCue: vi.fn(), setSfxEnabled: vi.fn() }}
      key='lobby'
      preferences={preferences}
      onClose={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('switch', { name: 'Music' }));
  expect(preferences.getSnapshot().bgmEnabled).toBe(false);
  expect(screen.getByRole('switch', { name: 'Music' }).getAttribute('aria-checked')).toBe('false');
  fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
  expect(preferences.getSnapshot().sfxEnabled).toBe(false);
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Forfeit' })).toBeNull();
  rerender(
    <SettingsLayer
      audio={{ playCue: vi.fn(), setSfxEnabled: vi.fn() }}
      key='reopened'
      preferences={preferences}
      onClose={() => undefined}
    />,
  );
  expect(screen.getAllByRole('alert')).toHaveLength(1);
});

test('only an explicit OFF to ON confirms; initial state and OFF are silent', () => {
  const preferences = createProductPreferences({ getItem: () => null, setItem: () => undefined });
  preferences.setLocale('en');
  const audio = { playCue: vi.fn(), setSfxEnabled: vi.fn() };
  render(<SettingsLayer preferences={preferences} audio={audio} onClose={() => undefined} />);
  expect(audio.setSfxEnabled).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
  expect(audio.setSfxEnabled).toHaveBeenLastCalledWith(false, true);
  fireEvent.click(screen.getByRole('switch', { name: 'Sound effects' }));
  expect(audio.setSfxEnabled).toHaveBeenLastCalledWith(true, true);
  expect(audio.setSfxEnabled).toHaveBeenCalledTimes(2);
  expect(audio.playCue).not.toHaveBeenCalled();
});

test('retries the selected locale after storage recovers without repeating its selection cue', () => {
  const values = new Map<string, string>();
  let storageAvailable = false;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (!storageAvailable) throw new Error('storage blocked');
      values.set(key, value);
    },
  };
  const preferences = createProductPreferences(storage);
  const audio = { playCue: vi.fn(), setSfxEnabled: vi.fn() };
  render(<SettingsLayer preferences={preferences} audio={audio} onClose={() => undefined} />);

  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByRole('button', { name: 'English', pressed: true })).toBeTruthy();
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(audio.playCue).toHaveBeenCalledTimes(1);

  storageAvailable = true;
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(createProductPreferences(storage).getSnapshot().locale).toBe('en');
  expect(audio.playCue).toHaveBeenCalledTimes(1);
});

test('translates immediately from the subscribed locale preference', () => {
  const preferences = createProductPreferences({ getItem: () => null, setItem: () => undefined });
  preferences.setLocale('ko');
  render(
    <SettingsLayer
      preferences={preferences}
      audio={{ playCue: vi.fn(), setSfxEnabled: vi.fn() }}
      onClose={() => undefined}
    />,
  );
  expect(screen.getByRole('switch', { name: '배경음' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'English' }));
  expect(screen.getByRole('switch', { name: 'Music' })).toBeTruthy();
  expect(preferences.getSnapshot().locale).toBe('en');
});
