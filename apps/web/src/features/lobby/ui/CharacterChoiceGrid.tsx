import { requireGameAsset } from '@repo/game-assets';
import type { CharacterId } from '@repo/game-assets/characters';

export type CharacterChoice = Readonly<{
  characterId: CharacterId;
  imageUrl: string;
  alt: string;
}>;

export type CharacterChoiceGridProps = Readonly<{
  label: string;
  choices: ReadonlyArray<CharacterChoice>;
  selectedCharacterId: CharacterId | null;
  variant: boolean;
  styleLabels: readonly [string, string];
  onStyleChange: (variant: boolean) => void;
  onSelect: (characterId: CharacterId) => void;
}>;

export function CharacterChoiceGrid({
  label,
  choices,
  selectedCharacterId,
  variant,
  styleLabels,
  onStyleChange,
  onSelect,
}: CharacterChoiceGridProps) {
  return (
    <div className='character-choice-grid' role='group' aria-label={label}>
      <div className='character-choice-grid__tabs' role='tablist' aria-label={label}>
        {styleLabels.map((styleLabel, index) => (
          <button
            key={styleLabel}
            type='button'
            role='tab'
            aria-selected={variant === (index === 1)}
            onClick={() => onStyleChange(index === 1)}
          >
            {styleLabel}
          </button>
        ))}
      </div>
      {choices.map((choice) => {
        const selected = choice.characterId === selectedCharacterId;
        return (
          <button
            className='character-choice-grid__choice'
            type='button'
            key={choice.characterId}
            data-character-id={choice.characterId}
            aria-label={choice.alt}
            aria-pressed={selected}
            onClick={() => onSelect(choice.characterId)}
          >
            <img src={choice.imageUrl} alt='' />
            {selected ? (
              <span className='character-choice-grid__selection' aria-hidden='true'>
                <img src={requireGameAsset('ui.selected-check').url} alt='' />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
