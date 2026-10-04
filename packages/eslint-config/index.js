import prettierConfig from 'eslint-config-prettier';
import { importX } from 'eslint-plugin-import-x';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

import flatCompat from './compat.js';

/**
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  ...flatCompat.config({
    extends: ['@rushstack/eslint-config/profile/web-app'],
  }),
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,
  {
    files: ['**/*.@(js|ts|jsx|tsx)'],
    ignores: [
      // Ignore dotfiles
      '.*.?(c)js',
      '*.config*.?(c)js',
      '.*.ts',
      '*.config*.ts',
      '*.d.ts',
      'dist',
      '.git',
      'node_modules',
      'build',
      '*rollup*',
      'out',
    ],
    plugins: {
      'import-x': importX,
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'no-var': 'error', // var 사용 금지
      'no-void': 'off', // 의도적으로 Promise를 fire-and-forget할 때 void 표현을 허용
      'no-unused-vars': 'error',
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      // Workspace packages may be consumed only through their package exports.
      'import-x/no-relative-packages': 'error',
      'prefer-destructuring': [
        'error',
        {
          VariableDeclarator: { array: false, object: true },
          AssignmentExpression: { array: false, object: false },
        },
      ],
    },
    settings: {
      'import-x/parsers': {
        '@typescript-eslint/parser': ['.ts', '.tsx'],
      },
      'import-x/resolver': {
        typescript: true,
      },
    },
    languageOptions: {
      parserOptions: {},
    },
  },
  {
    files: ['**/*.@(ts|tsx)'],
    rules: {
      'no-unused-vars': 'off', // typescript 로 검사하므로 충돌하지 않도록 설정 해제
      '@typescript-eslint/no-unused-vars': 'error',
      '@rushstack/typedef-var': 'off', // 인지 가능한 영역에 불필요한 룰
      '@rushstack/no-new-null': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      // React useEffect 안에서는 `void` 또는 내부 async 함수로 처리하고,
      // 그 외 코드에서는 떠다니는 Promise를 기본적으로 잡는다.
      '@typescript-eslint/no-floating-promises': [
        'error',
        {
          ignoreVoid: true,
          ignoreIIFE: true,
        },
      ],
      '@typescript-eslint/naming-convention': 'off',
      'import-x/extensions': [
        'error',
        'ignorePackages',
        {
          js: 'never',
          jsx: 'never',
          ts: 'never',
          tsx: 'never',
        },
      ],
    },
    languageOptions: {
      parserOptions: {
        project: false,
        projectService: true,
      },
    },
  },
  prettierConfig,
];
