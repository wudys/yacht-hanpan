import baseConfig from '@repo/eslint-config';

export default [
  ...baseConfig,
  {
    settings: {
      'import-x/core-modules': ['bun:test'],
    },
  },
];
