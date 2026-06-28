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
      // web/ is a self-contained Nuxt project with its own toolchain and lint
      // setup — the root linter must not descend into it (esp. its generated
      // .nuxt/.output).
      'web/**',
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
    files: ['tests/**/*.ts', 'services/*/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-assertions': ['warn', { assertionStyle: 'never' }],
    },
  },
);
