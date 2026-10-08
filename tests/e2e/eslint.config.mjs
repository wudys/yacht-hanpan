import baseConfig from '@repo/eslint-config';

export default [
  { ignores: ['playwright-report/**', 'test-results/**'] },
  ...baseConfig,
  {
    settings: {
      'import-x/core-modules': ['@playwright/test', 'bun:test'],
    },
  },
];
