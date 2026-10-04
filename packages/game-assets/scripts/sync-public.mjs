import { syncPublic } from './asset-pipeline.mjs';

const targetIndex = process.argv.indexOf('--target');
const target = targetIndex >= 0 ? process.argv[targetIndex + 1] : undefined;
if (!target) throw new Error('usage: bun sync-public.mjs --target <app-public-directory>');
console.log(`synced ${await syncPublic(target)} asset entries`);
