import { describe, expect, test, vi } from 'vitest';

import {
  createProductPreferences,
  type ProductPreferenceStorage,
} from '@/runtime/preferences/product-preferences';

class MemoryStorage implements ProductPreferenceStorage {
  readonly #values: Map<string, string>;

  public constructor(entries: readonly (readonly [string, string])[] = []) {
    this.#values = new Map(entries);
  }

  public getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

test('uses the stored BGM preference and defaults to enabled', () => {
  expect(createProductPreferences(new MemoryStorage()).getSnapshot().bgmEnabled).toBe(true);
  expect(
    createProductPreferences(new MemoryStorage([['bgmEnabled', 'false']])).getSnapshot().bgmEnabled,
  ).toBe(false);
});

describe('createProductPreferences', () => {
  test('loads validated preferences and defaults invalid stored values', () => {
    const stored = createProductPreferences(
      new MemoryStorage([
        ['locale', 'en'],
        ['bgmEnabled', 'false'],
        ['sfxEnabled', 'false'],
      ]),
    );
    expect(stored.getSnapshot()).toEqual({
      locale: 'en',
      bgmEnabled: false,
      sfxEnabled: false,
      storageFailed: false,
    });
    expect(stored.getSnapshot()).toBe(stored.getSnapshot());

    const invalid = createProductPreferences(
      new MemoryStorage([
        ['locale', 'ja'],
        ['bgmEnabled', 'disabled'],
        ['sfxEnabled', '0'],
      ]),
    );
    expect(invalid.getSnapshot()).toEqual({
      locale: 'ko',
      bgmEnabled: true,
      sfxEnabled: true,
      storageFailed: false,
    });
  });

  test('publishes only real value changes and detaches subscribers', () => {
    const storage = new MemoryStorage();
    const preferences = createProductPreferences(storage);
    const notify = vi.fn();
    const unsubscribe = preferences.subscribe(notify);
    const initial = preferences.getSnapshot();

    preferences.setLocale('en');
    const localized = preferences.getSnapshot();
    expect(localized).toEqual({
      locale: 'en',
      bgmEnabled: true,
      sfxEnabled: true,
      storageFailed: false,
    });
    expect(localized).not.toBe(initial);
    expect(notify).toHaveBeenCalledTimes(1);

    preferences.setLocale('en');
    expect(preferences.getSnapshot()).toBe(localized);
    expect(notify).toHaveBeenCalledTimes(1);

    preferences.setBgmEnabled(false);
    preferences.setSfxEnabled(false);
    expect(preferences.getSnapshot()).toEqual({
      locale: 'en',
      bgmEnabled: false,
      sfxEnabled: false,
      storageFailed: false,
    });
    expect(notify).toHaveBeenCalledTimes(3);

    unsubscribe();
    preferences.setSfxEnabled(true);
    expect(notify).toHaveBeenCalledTimes(3);

    expect(createProductPreferences(storage).getSnapshot()).toEqual({
      locale: 'en',
      bgmEnabled: false,
      sfxEnabled: true,
      storageFailed: false,
    });
  });

  test('keeps changed state after a failed write and retries the same value', () => {
    const values = new Map<string, string>();
    let storageAvailable = false;
    const storage: ProductPreferenceStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (!storageAvailable) throw new Error('storage denied');
        values.set(key, value);
      },
    };
    const preferences = createProductPreferences(storage);
    const notify = vi.fn();
    preferences.subscribe(notify);

    preferences.setLocale('en');
    const changed = preferences.getSnapshot();
    expect(changed).toEqual({
      locale: 'en',
      bgmEnabled: true,
      sfxEnabled: true,
      storageFailed: true,
    });
    expect(notify).toHaveBeenCalledTimes(1);

    storageAvailable = true;
    preferences.setLocale('en');
    expect(preferences.getSnapshot()).not.toBe(changed);
    expect(preferences.getSnapshot().storageFailed).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(createProductPreferences(storage).getSnapshot().locale).toBe('en');
  });

  test('tracks failures per preference until every failed key succeeds', () => {
    const failedKeys = new Set(['locale', 'bgmEnabled']);
    const storage: ProductPreferenceStorage = {
      getItem: () => null,
      setItem: (key) => {
        if (failedKeys.has(key)) throw new Error(`storage denied for ${key}`);
      },
    };
    const preferences = createProductPreferences(storage);
    const notify = vi.fn();
    preferences.subscribe(notify);

    preferences.setLocale('en');
    preferences.setBgmEnabled(false);
    const bothFailed = preferences.getSnapshot();
    expect(bothFailed.storageFailed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(2);

    failedKeys.delete('locale');
    preferences.setLocale('en');
    expect(preferences.getSnapshot()).toBe(bothFailed);
    expect(notify).toHaveBeenCalledTimes(2);

    preferences.setSfxEnabled(false);
    expect(preferences.getSnapshot().storageFailed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(3);

    failedKeys.delete('bgmEnabled');
    preferences.setBgmEnabled(false);
    expect(preferences.getSnapshot().storageFailed).toBe(false);
    expect(notify).toHaveBeenCalledTimes(4);
  });

  test('publishes storage status changes for same-value failure and retry', () => {
    let storageAvailable = false;
    const preferences = createProductPreferences({
      getItem: () => null,
      setItem: () => {
        if (!storageAvailable) throw new Error('storage denied');
      },
    });
    const notify = vi.fn();
    preferences.subscribe(notify);

    preferences.setBgmEnabled(true);
    expect(preferences.getSnapshot().storageFailed).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);

    storageAvailable = true;
    preferences.setBgmEnabled(true);
    const recovered = preferences.getSnapshot();
    expect(recovered.storageFailed).toBe(false);
    expect(notify).toHaveBeenCalledTimes(2);

    preferences.setBgmEnabled(true);
    expect(preferences.getSnapshot()).toBe(recovered);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  test('uses defaults when preference reads throw', () => {
    const preferences = createProductPreferences({
      getItem: () => {
        throw new Error('storage denied');
      },
      setItem: () => undefined,
    });

    expect(preferences.getSnapshot()).toEqual({
      locale: 'ko',
      bgmEnabled: true,
      sfxEnabled: true,
      storageFailed: false,
    });
  });
});
