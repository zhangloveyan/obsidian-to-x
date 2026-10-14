import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default ts.config(
  { ignores: ['node_modules/**', 'dist/**', 'work/**', 'main.js'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { files: ['src/**/*.ts'], plugins: { obsidianmd }, rules: {
    'obsidianmd/no-static-styles-assignment': 'error',
    'obsidianmd/no-forbidden-elements': 'error',
    'obsidianmd/settings-tab/no-manual-html-headings': 'error'
  } },
  { files: ['**/*.ts'], languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    '@typescript-eslint/consistent-type-imports': 'error'
  } }
);
