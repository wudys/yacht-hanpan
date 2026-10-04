import { GAME_ASSET_MANIFEST } from './manifest.generated';
import type { GameAssetManifestEntry } from './types';

export type GameAssetId = (typeof GAME_ASSET_MANIFEST)[number]['id'];

/** Required product assets are build invariants; this only resolves metadata. */
export function requireGameAsset(id: GameAssetId): GameAssetManifestEntry {
  const entry = GAME_ASSET_MANIFEST.find((asset) => asset.id === id);
  if (!entry) throw new Error(`Required game asset is missing: ${id}`);
  return entry;
}
