import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const { workspaces } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);

// Workspace patterns currently select immediate children (for example, packages/*).
const workspaceNames = workspaces
  .map((pattern) => new URL(pattern.replace(/\*$/, ''), import.meta.url))
  .filter((directory) => existsSync(directory))
  .flatMap((directory) =>
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => new URL(`${entry.name}/package.json`, directory)),
  )
  .filter((manifest) => existsSync(manifest))
  .map((manifest) => JSON.parse(readFileSync(manifest, 'utf8')).name);
const escapePattern = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const workspacePattern = `^(${workspaceNames.map(escapePattern).join('|')})(/|$|\\u0000)`;
const builtinPattern = `^(node:|(${builtinModules.map(escapePattern).join('|')})($|\\u0000))`;

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist*/**',
      '**/out-tsc/**',
      '**/coverage/**',
      '**/generated/**',
      '**/vendor/**',
      '**/.git/**',
      '**/.nx/**',
      '**/.cache/**',
      '**/.venv/**',
      '.claude/**',
      '.journal/**',
      '.llm-lab/**',
      '.doric/**',
      '**/output/**',
      '**/results/**',
      '**/fixtures/**',
      'tmp/**',
      'local_cache/**',
      'models/**/artifact*/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,mts,cts,tsx}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: [
      '{packages,agents,bundles,tools,benchmarks,app}/*/{src,tests,tools}/**/*.{ts,mts,cts,tsx}',
      '{packages,agents,bundles,tools,benchmarks,app}/*/index.{ts,mts,cts,tsx}',
    ],
    extends: [
      tseslint.configs.recommendedTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: [
          './{packages,agents,bundles,tools,benchmarks}/*/tsconfig.{lib,app,spec,e2e}.json',
          './{packages,agents,bundles,tools,benchmarks}/*/tsconfig.json',
          './app/*/tsconfig.{lib,app,spec,e2e}.json',
          './app/*/tsconfig.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
    plugins: {
      'simple-import-sort': simpleImportSort,
    },
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^\\u0000'], // Side-effect imports retain their relative order.
            [builtinPattern],
            ['^'], // External modules; the more specific groups below take precedence.
            [workspacePattern],
            ['^\\.\\.(/|$)', '^\\./', '^\\.$'],
          ],
        },
      ],
    },
  },
  // Keep formatting with Prettier, including when upstream presets evolve.
  prettier,
);
