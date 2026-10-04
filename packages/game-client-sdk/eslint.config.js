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
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/typedef': 'off',
      'require-atomic-updates': 'off',
    },
  },
];
