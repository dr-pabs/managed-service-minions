import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    name: 'ignore-patterns',
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      '**/.data/**',
      '**/coverage/**',
      '.github/**',
      '.plugin/**',
      'adrs/**',
      'docs/**',
      'agents/**',
      'skills/**',
      'commands/**',
      'rules/**',
      'schemas/**',
      'hooks/**',
    ],
  },
  {
    name: 'global-language-options',
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    name: 'framework-rules',
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off',
    },
  }
);
