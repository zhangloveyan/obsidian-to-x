import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';

export default ts.config(
  { ignores: ['node_modules/**', 'dist/**', 'work/**', 'main.js'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['**/*.ts'], languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error'
  } }
);
