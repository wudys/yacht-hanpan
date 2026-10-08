import baseConfig from '@repo/eslint-config';

export default [
  ...baseConfig,
  {
    settings: {
      'import-x/core-modules': ['bun:test'],
    },
  },
  {
    files: ['src/contract/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '../**',
                '@repo/dice-simulation',
                '@repo/dice-simulation/simulate',
                '@repo/dice-simulation/rapier/**',
                '@dimforge/rapier3d-deterministic',
                '@dimforge/rapier3d-deterministic/**',
              ],
              message:
                'Simulation contracts must stay independent of simulation and Rapier implementations.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      'require-atomic-updates': 'off',
    },
  },
  {
    files: ['src/simulate/internal/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/explicit-member-accessibility': 'off',
      '@typescript-eslint/parameter-properties': 'off',
      '@typescript-eslint/typedef': 'off',
    },
  },
  {
    files: ['src/simulate/simulate-physics.ts'],
    rules: {
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/typedef': 'off',
    },
  },
];
