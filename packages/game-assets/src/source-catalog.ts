import { CHARACTER_CATALOG } from './characters';
import { ASSET_KIND, type AssetKind } from './types';

export type AssetSource = Readonly<{
  id: string;
  sourcePath: string;
  kind: AssetKind;
}>;

const SCORE_ICON_NAMES = [
  'ones',
  'twos',
  'threes',
  'fours',
  'fives',
  'sixes',
  'choice',
  'four-of-a-kind',
  'full-house',
  'small-straight',
  'large-straight',
  'yacht',
] as const;

const scoreIcons: readonly AssetSource[] = SCORE_ICON_NAMES.map((name) => ({
  id: `score.${name}`,
  sourcePath: `files/score-icons/${name}.svg`,
  kind: ASSET_KIND.SVG,
}));

const sceneBgm: readonly AssetSource[] = [
  {
    id: 'audio.bgm.lobby',
    sourcePath: 'files/audio/bgm/lobby.mp3',
    kind: ASSET_KIND.AUDIO,
  },
  {
    id: 'audio.bgm.game',
    sourcePath: 'files/audio/bgm/game.mp3',
    kind: ASSET_KIND.AUDIO,
  },
  {
    id: 'audio.bgm.result',
    sourcePath: 'files/audio/bgm/result.mp3',
    kind: ASSET_KIND.AUDIO,
  },
];

const characterImages: readonly AssetSource[] = CHARACTER_CATALOG.flatMap(
  ({ id, imageAssetIds }) => [
    {
      id: imageAssetIds.original,
      sourcePath: `files/characters/${id}-original.png`,
      kind: ASSET_KIND.IMAGE,
    },
    {
      id: imageAssetIds.variant,
      sourcePath: `files/characters/${id}-variant.png`,
      kind: ASSET_KIND.IMAGE,
    },
  ],
);

export const ASSET_SOURCE_CATALOG: readonly AssetSource[] = Object.freeze([
  ...scoreIcons,
  ...characterImages,
  {
    id: 'brand.logo',
    sourcePath: 'files/brand/yacht-hanpan-logo.png',
    kind: ASSET_KIND.IMAGE,
  },
  {
    id: 'brand.ci.flat',
    sourcePath: 'files/brand/yacht-hanpan-ci-flat.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'brand.favicon',
    sourcePath: 'files/brand/favicon.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'brand.social-card',
    sourcePath: 'files/brand/social-card.png',
    kind: ASSET_KIND.IMAGE,
  },
  {
    id: 'brand.wrapper-pattern',
    sourcePath: 'files/brand/wrapper-pattern.png',
    kind: ASSET_KIND.IMAGE,
  },
  {
    id: 'ui.crown',
    sourcePath: 'files/ui/crown.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.close',
    sourcePath: 'files/ui/close.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.scoreboard',
    sourcePath: 'files/ui/sheet.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.settings',
    sourcePath: 'files/ui/setting.svg',
    kind: ASSET_KIND.SVG,
  },
  ...sceneBgm,
  {
    id: 'ui.bonus-check-inactive',
    sourcePath: 'files/ui/bonus-check-inactive.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.bonus-check-active',
    sourcePath: 'files/ui/bonus-check-active.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.language',
    sourcePath: 'files/ui/language.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.music',
    sourcePath: 'files/ui/music.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.selected-check',
    sourcePath: 'files/ui/selected-check.svg',
    kind: ASSET_KIND.SVG,
  },
  {
    id: 'ui.sound',
    sourcePath: 'files/ui/sound.svg',
    kind: ASSET_KIND.SVG,
  },
]);
