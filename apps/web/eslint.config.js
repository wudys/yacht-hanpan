import baseConfig from '@repo/eslint-config/react';
import { fileURLToPath } from 'node:url';

const browserImportRestrictions = {
  patterns: [
    {
      group: ['@repo/server', '@repo/server/*'],
      message: 'Browser code must not import server domain or runtime modules.',
    },
    {
      group: ['./*', '../*'],
      message: 'Use the @/* alias for imports inside this app.',
    },
  ],
};

const injectedViewRules = (allowedLocalImports) => ({
  'no-restricted-imports': [
    'error',
    {
      ...browserImportRestrictions,
      patterns: [
        ...browserImportRestrictions.patterns,
        {
          regex: `^@/(?!${allowedLocalImports})`,
          message: 'UI receives product state and translated copy through props.',
        },
        {
          regex: '^@repo/(?!(?:yacht-rules|game-assets(?:/characters)?)$)',
          message:
            'UI may consume pure game rules and static asset metadata, not runtime resources.',
        },
      ],
    },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: 'ImportExpression',
      message: 'Load modules in application composition or runtime, outside the injected UI.',
    },
  ],
});

export default [
  { ignores: ['dist/**'] },
  ...baseConfig,
  {
    settings: {
      'import-x/resolver': {
        typescript: {
          project: fileURLToPath(new URL('./tsconfig.json', import.meta.url)),
        },
      },
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', browserImportRestrictions],
    },
  },
  {
    files: ['src/features/lobby/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...browserImportRestrictions,
          patterns: [
            ...browserImportRestrictions.patterns,
            {
              group: [
                '@/runtime/session/session-credential-store',
                '@/runtime/session/game-session-holder',
                '@/runtime/session/session-recovery',
                '@/runtime/room-access/stored-room-reentry',
                '@/runtime/room-access/waiting-operations',
                '@/runtime/network/server-readiness',
              ],
              message:
                'Lobby consumes room access; admission, authority, restore and recovery belong to runtime.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/runtime/dice/game-dice-layout.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!@/ui/layout/dice-board-layout$|@repo/dice-simulation/contract$)',
              message: 'Dice layout consumes only pure UI dimensions and simulation contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/runtime/dice/{renderer,replay,resources}/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          ...browserImportRestrictions,
          patterns: [
            ...browserImportRestrictions.patterns,
            {
              regex:
                '^@/(?!runtime/dice/(?:(?:renderer|replay|resources)(?:/|$)|game-dice-layout$))',
              message: 'Dice rendering receives product state through its caller, not app imports.',
            },
            {
              regex: '^@repo/(?!dice-simulation(?:/|$))',
              message: 'Dice rendering consumes simulation contracts, not game rules or transport.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: injectedViewRules('ui(?:/|$)'),
  },
  ...['entry', 'loading', 'settings', 'lobby', 'game'].map((feature) => ({
    files: [`src/features/${feature}/view/**/*.{ts,tsx}`],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: injectedViewRules(`(?:ui(?:/|$)|features/${feature}/view(?:/|$))`),
  })),
];
