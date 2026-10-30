import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-plugin-prettier/recommended';
import stylistic from '@stylistic/eslint-plugin';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const TS_FILES = ['src/**/*.ts', 'test/**/*.ts'];

export default defineConfig(
  {
    ignores: ['node_modules/**', 'dist/**', 'dist-test/**', 'state/**', 'output/**', 'secrets/**'],
  },
  {
    files: TS_FILES,
    extends: [eslint.configs.recommended, ...tseslint.configs.recommendedTypeChecked, prettier],
    plugins: { '@stylistic': stylistic },
    languageOptions: {
      globals: globals.node,
      sourceType: 'module',
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/return-await': 'error',
      '@typescript-eslint/no-unsafe-function-type': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@stylistic/lines-between-class-members': [
        'error',
        {
          enforce: [
            { blankLine: 'always', prev: '*', next: 'method' },
            { blankLine: 'always', prev: 'method', next: '*' },
          ],
        },
      ],
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: 'return' },
        { blankLine: 'always', prev: '*', next: 'block-like' },
        { blankLine: 'always', prev: 'block-like', next: '*' },
        { blankLine: 'never', prev: 'case', next: '*' },
        { blankLine: 'never', prev: '*', next: 'case' },
      ],
      'no-console': 'error',
      curly: 'error',
      eqeqeq: ['error', 'always'],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'IfStatement[alternate!=null]',
          message: 'Use early return; else/else if are forbidden.',
        },
      ],
      'no-empty': ['error', { allowEmptyCatch: false }],
      'prettier/prettier': 'warn',
    },
  },
  {
    files: ['src/**/*.ts'],
    rules: {
      // Keep test-runner APIs out of runtime code.
      'no-restricted-imports': ['error', { paths: ['node:test', 'vitest'] }],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      // Mocks preserve the asynchronous transport contract without needing await.
      '@typescript-eslint/require-await': 'off',
      // The node:test runner awaits tests registered at module scope.
      '@typescript-eslint/no-floating-promises': [
        'error',
        { allowForKnownSafeCalls: [{ from: 'package', package: 'node:test', name: 'test' }] },
      ],
    },
  },
  {
    files: ['*.mjs', 'scripts/*.mjs'],
    extends: [eslint.configs.recommended, prettier],
    languageOptions: { globals: globals.node },
    rules: {
      'no-console': 'error',
      curly: 'error',
      eqeqeq: ['error', 'always'],
      'prettier/prettier': 'warn',
    },
  },
);
