import baseConfig from '@repo/eslint-config';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const appImportPatterns = [
  {
    group: ['./*', '../*'],
    message: 'Use the @/* alias for imports inside this app.',
  },
];

const domainImportPaths = builtinModules.map((name) => ({
  name,
  message: 'Domain rules receive inputs; platform effects belong outside the domain.',
}));

const domainImportPatterns = [
  ...appImportPatterns,
  {
    regex: '^@/(?!rooms/domain(?:/|$))',
    message: 'Domain rules do not depend on application, transport or runtime owners.',
  },
  {
    regex: '^(?!@/|@repo/(?:game-assets/characters|yacht-rules)$)',
    message: 'Domain rules may consume pure game and character contracts, not runtime packages.',
  },
];

export default [
  { ignores: ['dist/**'] },
  ...baseConfig,
  {
    settings: {
      'import-x/core-modules': ['bun:test'],
      'import-x/resolver': {
        typescript: {
          project: fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
        },
      },
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: appImportPatterns }],
    },
  },
  {
    files: ['src/rooms/domain/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: domainImportPaths,
          patterns: domainImportPatterns,
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'Runtime module loading belongs outside pure domain rules.',
        },
      ],
    },
  },
  {
    files: ['src/rooms/domain/match/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: domainImportPaths,
          patterns: [
            ...domainImportPatterns,
            {
              regex: '^@/rooms/domain/(?!match(?:/|$)|time$)',
              message: 'Match rules do not depend on room lifecycle or presence.',
            },
            {
              regex: '^@repo/(?!yacht-rules$)',
              message: 'Match rules only consume the shared Yacht rules.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/transport/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...appImportPatterns,
            {
              regex: '^@/rooms/(?!room-application$)',
              allowTypeImports: true,
              message: 'Transport executes room operations through RoomApplication.',
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
];
