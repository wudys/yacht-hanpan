import { requireGameAsset } from '@repo/game-assets';
import { CHARACTER_CATALOG } from '@repo/game-assets/characters';

export const LOBBY_ICONS = {
  close: requireGameAsset('ui.close').url,
};

export const characterChoices = (variant: boolean) =>
  CHARACTER_CATALOG.map(({ id, imageAssetIds }) => ({
    characterId: id,
    imageUrl: requireGameAsset(variant ? imageAssetIds.variant : imageAssetIds.original).url,
    alt: id,
  }));
