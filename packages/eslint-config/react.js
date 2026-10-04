import jsxA11yPlugin from 'eslint-plugin-jsx-a11y';
import reactPlugin from 'eslint-plugin-react';
// eslint-disable-next-line import-x/default
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import reactRefreshPlugin from 'eslint-plugin-react-refresh';
import testingLibraryPlugin from 'eslint-plugin-testing-library';
import globals from 'globals';

import baseConfig from './index.js';

const reactFiles = ['**/*.{js,mjs,cjs,jsx,mjsx,ts,tsx,mtsx}'];
const testFiles = ['**/__tests__/**/*.[jt]s?(x)', '**/?(*.)+(spec|test).[jt]s?(x)'];

function withFiles(config, files) {
  return {
    ...config,
    files: config.files ?? files,
  };
}

/**
 * @type {import('eslint').Linter.Config[]}
 */
export default [
  ...baseConfig,
  withFiles(reactPlugin.configs.flat.recommended, reactFiles),
  withFiles(reactPlugin.configs.flat['jsx-runtime'], reactFiles),
  ...reactHooksPlugin.configs['flat/recommended'].map((config) => withFiles(config, reactFiles)),
  {
    files: reactFiles,
    plugins: {
      'react-refresh': reactRefreshPlugin,
      'jsx-a11y': jsxA11yPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'jsx-a11y/alt-text': [
        'warn',
        {
          elements: ['img'],
        },
      ],
      'jsx-a11y/aria-props': 'warn',
      'jsx-a11y/aria-proptypes': 'warn',
      'jsx-a11y/aria-unsupported-elements': 'warn',
      'jsx-a11y/role-has-required-aria-props': 'warn',
      'jsx-a11y/role-supports-aria-props': 'warn',
      'react/no-unknown-property': 'off',
      // Component props are checked by TypeScript.
      'react/prop-types': 'off',
      'react/react-in-jsx-scope': 'off',
    },
    languageOptions: {
      ...reactPlugin.configs.flat.recommended.languageOptions,
      globals: {
        ...globals.serviceworker,
        ...globals.browser,
      },
    },
  },
  {
    files: testFiles,
    ...testingLibraryPlugin.configs['flat/react'],
    rules: {
      ...testingLibraryPlugin.configs['flat/react'].rules,
      'react-refresh/only-export-components': 'off',
    },
  },
];
