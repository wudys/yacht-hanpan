import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const output = process.argv[2] ?? fileURLToPath(new URL('../dist/', import.meta.url));
const files = await readdir(output, { recursive: true });
if (files.some((file) => file.endsWith('.map'))) {
  throw new Error(
    'Public build contains source maps. Do not publish until upload and removal succeed.',
  );
}
