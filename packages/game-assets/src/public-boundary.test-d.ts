import { requireGameAsset } from '@repo/game-assets';

// @ts-expect-error Removed or misspelled asset IDs must fail before product runtime.
requireGameAsset('brand.logo.removed');
