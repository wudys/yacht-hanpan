import baseConfig from './index.js';

export default [
  ...baseConfig,
  {
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
      },
    },
  },
];
