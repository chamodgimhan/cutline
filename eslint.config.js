import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'fixtures/out/**', 'desktop/dist/**', 'desktop/node_modules/**', 'desktop/app/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
    },
  },
  {
    // The desktop shell runs in Electron's main process (CommonJS, Node globals).
    files: ['desktop/*.cjs', 'desktop/*.mjs'],
    languageOptions: { globals: { require: 'readonly', __dirname: 'readonly', process: 'readonly', console: 'readonly', URL: 'readonly', Response: 'readonly', ReadableStream: 'readonly' } },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Pure editing logic: no UI, no browser, no node.
    files: ['src/core/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: {
      'no-restricted-globals': ['error', 'window', 'document', 'navigator', 'localStorage'],
      'no-restricted-imports': ['error', { patterns: ['**/ui/**', '**/engine/**', 'node:*'] }],
    },
  },
);
