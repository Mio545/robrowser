/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint', 'import'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended', 'prettier'],
  env: { node: true, es2022: true, browser: false },
  ignorePatterns: [
    '**/dist/**',
    '**/node_modules/**',
    '**/*.d.ts',
    '**/coverage/**',
    '**/.vite/**',
    '**/release/**',
    'packages/desktop/src/renderer/**',
  ],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-non-null-assertion': 'off',
    'no-console': ['error', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always'],
    'import/order': 'off',
  },
  overrides: [
    {
      files: ['packages/core/**/*.ts', 'packages/browser/**/*.ts'],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: 'electron', message: 'core/browser must stay host-agnostic (no electron).' },
              { name: 'react', message: 'core/browser must stay host-agnostic (no react).' },
              { name: 'fastify', message: 'core/browser must stay host-agnostic (no fastify).' },
              { name: 'express', message: 'core/browser must stay host-agnostic (no express).' },
            ],
          },
        ],
      },
    },
    {
      files: ['**/*.test.ts', '**/test/**/*.ts', 'scripts/**/*.ts', '**/*.config.ts'],
      env: { node: true },
      rules: { 'no-console': 'off' },
    },
    {
      files: ['packages/server/src/cli.ts'],
      rules: { 'no-console': 'off' },
    },
  ],
};
