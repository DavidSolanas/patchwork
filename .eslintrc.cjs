/* eslint-env node */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  env: {
    node: true,
    es2023: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.cjs'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        paths: [
          {
            name: '@octokit/rest',
            message:
              'Import @octokit/rest only inside src/github/**. Pass an Octokit instance to other modules instead.',
          },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['src/github/**/*.ts'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
    {
      files: ['src/**/__tests__/**/*.ts', 'src/**/*.test.ts'],
      rules: {
        'no-restricted-imports': 'off',
      },
    },
  ],
};
