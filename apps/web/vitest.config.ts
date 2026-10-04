import { fileURLToPath } from 'node:url';

import { defineConfig, mergeConfig } from 'vitest/config';

import viteConfig from './vite.config.ts'; // eslint-disable-line import-x/extensions -- Native Vite config requires extensions.

export default defineConfig((environment) =>
  mergeConfig(
    viteConfig(environment),
    defineConfig({
      resolve: {
        alias: [
          {
            // Rapier declares only a browser "module" entry. Vitest's Node
            // resolver omits that field; select the same installed entry that
            // the product uses and retain Vite's WASM-glue alias.
            find: /^@dimforge\/rapier3d-deterministic$/u,
            replacement: fileURLToPath(
              new URL(
                '../../packages/dice-simulation/node_modules/@dimforge/rapier3d-deterministic/rapier.js',
                import.meta.url,
              ),
            ),
          },
        ],
      },
      test: {
        server: { deps: { inline: ['@dimforge/rapier3d-deterministic'] } },
      },
    }),
  ),
);
