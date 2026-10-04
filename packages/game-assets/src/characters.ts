const CHARACTER_ID = {
  NAVY_BOB: 'navy-bob',
  BLONDE_BUNS: 'blonde-buns',
  SAGE_BUCKET: 'sage-bucket',
  ROSE_TAILS: 'rose-tails',
  BLACK_HIME: 'black-hime',
  BROWN_BRAID: 'brown-braid',
  SILVER_SWEEP: 'silver-sweep',
  ONYX_TOPKNOT: 'onyx-topknot',
  HONEY_CAP: 'honey-cap',
  ONYX_RIBBON: 'onyx-ribbon',
  PEACH_CURTAIN: 'peach-curtain',
  CHESTNUT_CURTAIN: 'chestnut-curtain',
} as const;

export type CharacterId = (typeof CHARACTER_ID)[keyof typeof CHARACTER_ID];
export type ProfileSelection = Readonly<{ characterId: CharacterId; variant: boolean }>;
export type CharacterImageAssetId = `character.${CharacterId}.${'original' | 'variant'}`;

export type CharacterDefinition = Readonly<{
  id: CharacterId;
  imageAssetIds: Readonly<{
    original: CharacterImageAssetId;
    variant: CharacterImageAssetId;
  }>;
}>;

export const CHARACTER_IDS: readonly CharacterId[] = Object.freeze(Object.values(CHARACTER_ID));

export const CHARACTER_CATALOG = Object.freeze(CHARACTER_IDS.map(defineCharacter));

const CHARACTERS_BY_ID: ReadonlyMap<CharacterId, CharacterDefinition> = new Map(
  CHARACTER_CATALOG.map((definition) => [definition.id, definition]),
);

export function isCharacterId(value: unknown): value is CharacterId {
  return typeof value === 'string' && CHARACTERS_BY_ID.has(value as CharacterId);
}

function getCharacter(characterId: CharacterId): CharacterDefinition {
  const definition = CHARACTERS_BY_ID.get(characterId);
  if (definition === undefined) throw new Error(`Unknown character ID: ${characterId}`);
  return definition;
}

export function resolveCharacterImageAssetId(
  characterId: CharacterId,
  variant: boolean,
): CharacterImageAssetId {
  const { imageAssetIds } = getCharacter(characterId);
  return variant ? imageAssetIds.variant : imageAssetIds.original;
}

function defineCharacter(id: CharacterId): CharacterDefinition {
  return Object.freeze({
    id,
    imageAssetIds: Object.freeze({
      original: `character.${id}.original`,
      variant: `character.${id}.variant`,
    }),
  });
}
