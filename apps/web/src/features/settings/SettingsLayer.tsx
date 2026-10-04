import { useSyncExternalStore } from 'react';

import { SettingsView } from '@/features/settings/view/SettingsView';
import { type Locale, translate } from '@/i18n';
import type { BrowserAudioRuntime } from '@/runtime/audio/browser-audio-runtime';
import { PRODUCT_CUE } from '@/runtime/audio/product-cues';
import type { PreferencesStore } from '@/runtime/preferences/preferences-store';

type SettingsLayerProps = Readonly<{
  preferences: PreferencesStore;
  audio: Pick<BrowserAudioRuntime, 'playCue' | 'setSfxEnabled'>;
  onClose: () => void;
  forfeit?: Readonly<{ disabled: boolean; onIntent: () => void }>;
}>;

export function SettingsLayer({ preferences, audio, onClose, forfeit }: SettingsLayerProps) {
  const values = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const { locale } = values;
  const settings = {
    labels: {
      title: translate(locale, 'settings.title'),
      close: translate(locale, 'common.close'),
      locale: translate(locale, 'settings.locale'),
      korean: translate(locale, 'settings.korean'),
      english: translate(locale, 'settings.english'),
      bgm: translate(locale, 'settings.bgm'),
      sfx: translate(locale, 'settings.sfx'),
      storageFailure: translate(locale, 'settings.storageFailure'),
    },
    ...values,
    onClose,
    onLocaleChange: (next: Locale) => {
      if (preferences.setLocale(next)) audio.playCue(PRODUCT_CUE.SELECT);
    },
    onBgmChange: (next: boolean) => {
      if (preferences.setBgmEnabled(next)) audio.playCue(PRODUCT_CUE.SELECT);
    },
    onSfxChange: (next: boolean) => {
      audio.setSfxEnabled(next, true);
      preferences.setSfxEnabled(next);
    },
  };
  return (
    <SettingsView
      {...settings}
      forfeit={
        forfeit
          ? {
              ...forfeit,
              label: translate(locale, 'game.forfeitAction'),
              description: translate(locale, 'settings.forfeitDescription'),
            }
          : undefined
      }
    />
  );
}
