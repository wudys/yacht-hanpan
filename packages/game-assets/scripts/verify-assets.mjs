import { verifySourceAssets } from './asset-pipeline.mjs';
import { GAME_ASSET_MANIFEST } from '../src/manifest.generated.ts';

const { errors, manifest } = await verifySourceAssets();
if (JSON.stringify(manifest) !== JSON.stringify(GAME_ASSET_MANIFEST)) {
  errors.push('generated manifest is stale; run bun run generate');
}
if (errors.length > 0) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`verified ${manifest.length} asset entries`);
}
