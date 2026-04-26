import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.venv/**',
      '.husky/_/**',
      'data/**',
      'ha-data/**',
      'models/**',
      'coverage/**',
      'scripts/*.py',
      '**/*.onnx',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  prettier,
  {
    rules: {
      curly: ['error', 'all'],
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'never' }],
    },
  },
);
