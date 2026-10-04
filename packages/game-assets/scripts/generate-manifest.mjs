import { writeGeneratedManifest } from './asset-pipeline.mjs';

const manifest = await writeGeneratedManifest();
console.log(`generated ${manifest.length} asset entries`);
