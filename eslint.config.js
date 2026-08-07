import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // functions/ is a separate npm package (SEC-003) with its own
  // eslint.config.mjs/tsconfig.json and its own dedicated lint job in CI —
  // including it here makes typescript-eslint's project service see two
  // conflicting tsconfigRootDir candidates and fail to parse every file
  // under functions/**. Excluded via globalIgnores (not a CLI flag) so
  // both the CI `npm run lint` step and any local/deploy invocation of the
  // same script behave identically.
  globalIgnores(['dist', 'functions/**']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
])
