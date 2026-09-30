import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/**
 * One flat config for the whole monorepo. Each workspace's `lint` script runs
 * ESLint from its own directory, and ESLint resolves this file by walking up,
 * so the rules are identical everywhere and there is nothing to keep in sync.
 */
export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      'apps/web/next-env.d.ts',
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      // An underscore marks a parameter that an interface requires but this
      // implementation deliberately does not use.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Build and tool configuration files run in Node, not the browser. Only the
  // globals they actually use are declared, rather than pulling in a package
  // for three small files.
  {
    files: ['**/*.{mjs,cjs,js}'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly' } },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
    // Absolute, because ESLint runs from the workspace directory in `npm run
    // lint` but from the repository root in editors and `next build`.
    settings: { next: { rootDir: fileURLToPath(new URL('./apps/web/', import.meta.url)) } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
);
