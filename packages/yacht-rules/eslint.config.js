import baseConfig from '@repo/eslint-config';

export default [
  ...baseConfig,
  {
    settings: {
      'import-x/core-modules': ['bun:test'],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'require-atomic-updates': 'off',
    },
  },
];
