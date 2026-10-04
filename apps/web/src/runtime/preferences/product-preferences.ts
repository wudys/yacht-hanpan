import { type Locale, normalizeLocale } from '@/i18n';

const BGM_ENABLED_STORAGE_KEY = 'bgmEnabled';
const LOCALE_STORAGE_KEY = 'locale';
const SFX_ENABLED_STORAGE_KEY = 'sfxEnabled';

export interface ProductPreferenceStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export type ProductPreferencesSnapshot = Readonly<{
  locale: Locale;
  bgmEnabled: boolean;
  sfxEnabled: boolean;
  storageFailed: boolean;
}>;

export interface ProductPreferences {
  getSnapshot(): ProductPreferencesSnapshot;
  subscribe(listener: () => void): () => void;
  setLocale(locale: Locale): boolean;
  setBgmEnabled(enabled: boolean): boolean;
  setSfxEnabled(enabled: boolean): void;
}

export function createProductPreferences(storage: ProductPreferenceStorage): ProductPreferences {
  let snapshot: ProductPreferencesSnapshot = {
    locale: readStoredLocale(storage),
    bgmEnabled: readItem(storage, BGM_ENABLED_STORAGE_KEY) !== 'false',
    sfxEnabled: readItem(storage, SFX_ENABLED_STORAGE_KEY) !== 'false',
    storageFailed: false,
  };
  const subscribers = new Set<() => void>();
  const failedPreferenceKeys = new Set<string>();

  function publish(): void {
    for (const subscriber of subscribers) subscriber();
  }

  function persist(key: string, value: string): void {
    try {
      storage.setItem(key, value);
      failedPreferenceKeys.delete(key);
    } catch {
      failedPreferenceKeys.add(key);
    }
  }

  function updateStorageFailed(): boolean {
    const storageFailed = failedPreferenceKeys.size > 0;
    if (snapshot.storageFailed === storageFailed) return false;
    snapshot = { ...snapshot, storageFailed };
    return true;
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    setLocale(locale: Locale) {
      const changed = snapshot.locale !== locale;
      if (changed) snapshot = { ...snapshot, locale };
      persist(LOCALE_STORAGE_KEY, locale);
      if (updateStorageFailed() || changed) publish();
      return changed;
    },
    setBgmEnabled(bgmEnabled: boolean) {
      const changed = snapshot.bgmEnabled !== bgmEnabled;
      if (changed) snapshot = { ...snapshot, bgmEnabled };
      persist(BGM_ENABLED_STORAGE_KEY, String(bgmEnabled));
      if (updateStorageFailed() || changed) publish();
      return changed;
    },
    setSfxEnabled(sfxEnabled: boolean) {
      let changed = snapshot.sfxEnabled !== sfxEnabled;
      if (changed) snapshot = { ...snapshot, sfxEnabled };
      persist(SFX_ENABLED_STORAGE_KEY, String(sfxEnabled));
      changed = updateStorageFailed() || changed;
      if (changed) publish();
    },
  };
}

export function readStoredLocale(storage: Pick<ProductPreferenceStorage, 'getItem'>): Locale {
  return normalizeLocale(readItem(storage, LOCALE_STORAGE_KEY));
}

function readItem(storage: Pick<ProductPreferenceStorage, 'getItem'>, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}
