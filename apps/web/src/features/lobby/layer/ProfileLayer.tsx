import type { CharacterId } from '@repo/game-assets/characters';

import { LobbyLayer } from '@/features/lobby/layer/LobbyLayer';
import { characterChoices, LOBBY_ICONS } from '@/features/lobby/lobby-assets';
import { CharacterChoiceGrid } from '@/features/lobby/view/CharacterChoiceGrid';
import { type Locale, translate } from '@/i18n';
import { IconButton } from '@/ui/button';
import { ScrollablePanel } from '@/ui/panel';

export function ProfileLayer({
  locale,
  variant,
  selectedCharacterId,
  storageFailed,
  onStyleChange,
  onSelect,
  onClose,
}: Readonly<{
  locale: Locale;
  variant: boolean;
  selectedCharacterId: CharacterId | null;
  storageFailed: boolean;
  onStyleChange: (variant: boolean) => void;
  onSelect: (characterId: CharacterId) => void;
  onClose: () => void;
}>) {
  return (
    <LobbyLayer>
      <ScrollablePanel
        className='web-lobby-surface'
        title={translate(locale, 'profile.title')}
        headerAction={
          <IconButton
            label={translate(locale, 'common.close')}
            icon={<img src={LOBBY_ICONS.close} alt='' />}
            onClick={onClose}
          />
        }
      >
        <CharacterChoiceGrid
          label={translate(locale, 'profile.choose')}
          choices={characterChoices(variant)}
          selectedCharacterId={selectedCharacterId}
          variant={variant}
          styleLabels={[translate(locale, 'profile.style1'), translate(locale, 'profile.style2')]}
          onStyleChange={onStyleChange}
          onSelect={onSelect}
        />
        {storageFailed ? (
          <p className='product-inline-feedback web-profile-storage-error' role='alert'>
            {translate(locale, 'profile.storageFailure')}
          </p>
        ) : null}
      </ScrollablePanel>
    </LobbyLayer>
  );
}
