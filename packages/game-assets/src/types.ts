export const ASSET_KIND = {
  IMAGE: 'image',
  SVG: 'svg',
  AUDIO: 'audio',
} as const;

export type AssetKind = (typeof ASSET_KIND)[keyof typeof ASSET_KIND];

export type GameAssetManifestEntry = Readonly<{
  id: string;
  kind: AssetKind;
  url: string;
  bytes: number;
  sha256: string;
  mime: string;
  width?: number;
  height?: number;
}>;
