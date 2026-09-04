import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import react from 'eslint-plugin-react';

export default [
  { ignores: ['**/node_modules/**', 'frontend/dist/**'] },

  js.configs.recommended,

  {
    rules: {
      // Several catch blocks swallow deliberately and say why in a comment;
      // the rule cannot see the comment.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        // Destructuring a field out in order to drop it is how password hashes
        // are kept out of API responses.
        ignoreRestSiblings: true,
        argsIgnorePattern: '^_'
      }]
    }
  },

  {
    files: ['backend/**/*.{js,mjs}', 'tools/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node
    }
  },

  {
    files: ['frontend/**/*.{js,jsx}', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node }
    },
    plugins: { 'react-hooks': reactHooks, react },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Without this a component is "unused" unless it is called, and every
      // one of them is only ever written as a tag.
      'react/jsx-uses-vars': 'error'
    }
  }
];
