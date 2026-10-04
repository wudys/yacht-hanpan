import baseConfig from '@repo/eslint-config';

/** @type {import("eslint").Linter.Config[]} */
export default [
  ...baseConfig,
  {
    ignores: ['apps/**', 'packages/**', '.scratch/**', 'docs/**'],
  },
  {
    files: ['scripts/**/*.mjs'],
    settings: {
      'import-x/core-modules': ['bun:test'],
    },
  },
];
