import { requireGameAsset } from '@repo/game-assets';

import { Button, IconButton } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export type SettingsLocale = 'ko' | 'en';

export type SettingsLabels = Readonly<{
  title: string;
  close: string;
  locale: string;
  korean: string;
  english: string;
  bgm: string;
  sfx: string;
  storageFailure?: string;
}>;

export type SettingsViewProps = Readonly<{
  labels: SettingsLabels;
  locale: SettingsLocale;
  bgmEnabled: boolean;
  sfxEnabled: boolean;
  storageFailed?: boolean;
  onClose: () => void;
  onLocaleChange: (locale: SettingsLocale) => void;
  onBgmChange: (enabled: boolean) => void;
  onSfxChange: (enabled: boolean) => void;
  forfeit?: SettingsForfeit;
}>;

export type SettingsForfeit = Readonly<{
  label: string;
  description: string;
  disabled: boolean;
  onIntent: () => void;
}>;

const closeIconUrl = requireGameAsset('ui.close').url;
const languageIconUrl = requireGameAsset('ui.language').url;
const musicIconUrl = requireGameAsset('ui.music').url;
const soundIconUrl = requireGameAsset('ui.sound').url;

const icons = {
  locale: (
    <span
      className='settings-view__asset-icon'
      aria-hidden='true'
      style={{ maskImage: `url(${languageIconUrl})` }}
    />
  ),
  bgm: (
    <span
      className='settings-view__asset-icon'
      aria-hidden='true'
      style={{ maskImage: `url(${musicIconUrl})` }}
    />
  ),
  sfx: (
    <span
      className='settings-view__asset-icon'
      aria-hidden='true'
      style={{ maskImage: `url(${soundIconUrl})` }}
    />
  ),
};

export function SettingsView({
  labels,
  locale,
  bgmEnabled,
  sfxEnabled,
  storageFailed = false,
  onClose,
  onLocaleChange,
  onBgmChange,
  onSfxChange,
  forfeit,
}: SettingsViewProps) {
  return (
    <div className='settings-view'>
      <ScrollablePanel
        title={labels.title}
        headerAction={
          <IconButton
            label={labels.close}
            icon={<img src={closeIconUrl} alt='' />}
            onClick={onClose}
          />
        }
      >
        <div className='settings-view__content'>
          <div className='settings-view__preferences'>
            <div className='settings-view__preference' data-settings-row='locale'>
              <span className='settings-view__preference-label'>
                <span className='settings-view__preference-icon' data-settings-icon='locale'>
                  {icons.locale}
                </span>
                <span>{labels.locale}</span>
              </span>
              <div
                className='settings-view__locale-options'
                role='group'
                aria-label={labels.locale}
              >
                <button
                  type='button'
                  data-settings-locale='ko'
                  aria-pressed={locale === 'ko'}
                  onClick={() => onLocaleChange('ko')}
                >
                  {labels.korean}
                </button>
                <button
                  type='button'
                  data-settings-locale='en'
                  aria-pressed={locale === 'en'}
                  onClick={() => onLocaleChange('en')}
                >
                  {labels.english}
                </button>
              </div>
            </div>
            <div className='settings-view__preference' data-settings-row='bgm'>
              <span className='settings-view__preference-label'>
                <span className='settings-view__preference-icon' data-settings-icon='bgm'>
                  {icons.bgm}
                </span>
                <span>{labels.bgm}</span>
              </span>
              <button
                type='button'
                className='settings-view__switch'
                data-settings-control='bgm'
                role='switch'
                aria-label={labels.bgm}
                aria-checked={bgmEnabled}
                onClick={() => onBgmChange(!bgmEnabled)}
              >
                <span className='settings-view__switch-track' aria-hidden='true'>
                  <span />
                </span>
              </button>
            </div>
            <div className='settings-view__preference' data-settings-row='sfx'>
              <span className='settings-view__preference-label'>
                <span className='settings-view__preference-icon' data-settings-icon='sfx'>
                  {icons.sfx}
                </span>
                <span>{labels.sfx}</span>
              </span>
              <button
                type='button'
                className='settings-view__switch'
                data-settings-control='sfx'
                role='switch'
                aria-label={labels.sfx}
                aria-checked={sfxEnabled}
                onClick={() => onSfxChange(!sfxEnabled)}
              >
                <span className='settings-view__switch-track' aria-hidden='true'>
                  <span />
                </span>
              </button>
            </div>
          </div>

          {storageFailed && labels.storageFailure ? (
            <p className='product-inline-feedback settings-view__storage-error' role='alert'>
              {labels.storageFailure}
            </p>
          ) : null}

          {forfeit ? (
            <section className='settings-view__danger' data-settings-danger='true'>
              <p>{forfeit.description}</p>
              <div data-settings-action='forfeit'>
                <Button
                  label={forfeit.label}
                  variant='danger'
                  disabled={forfeit.disabled}
                  onClick={forfeit.onIntent}
                />
              </div>
            </section>
          ) : null}
        </div>
      </ScrollablePanel>
    </div>
  );
}
