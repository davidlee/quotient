// Lint for agent-written code (IMP-002). Adapted from malebolge's config,
// itself from SATAN doctrine IMP-041 (rule list) and DEC-053 (zero warnings).
import { defineConfig } from 'eslint/config';
import importX from 'eslint-plugin-import-x';
import unicorn from 'eslint-plugin-unicorn';
import unusedImports from 'eslint-plugin-unused-imports';
import tseslint from 'typescript-eslint';

export default defineConfig(
  { ignores: ['node_modules', 'dist', 'result', '.direnv', '.pi', '.doctrine'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      'import-x': importX,
      unicorn,
      'unused-imports': unusedImports,
    },
    rules: {
      // Unsafe family and promise hygiene (strictTypeChecked sets these;
      // stated so the intent survives preset drift).
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',

      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowNullableEnum: false,
          allowAny: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      complexity: ['error', 8],
      'max-depth': ['error', 3],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'no-nested-ternary': 'error',

      'import-x/order': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': true }],
      'unused-imports/no-unused-imports': 'error',

      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      'unicorn/prefer-node-protocol': 'error',
      'unicorn/no-array-reduce': 'error',
    },
  },
  {
    // Tests are colocated (`src/**/*.test.ts`): a `describe` body is one function.
    files: ['src/**/*.test.ts'],
    rules: { 'max-lines-per-function': 'off' },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
