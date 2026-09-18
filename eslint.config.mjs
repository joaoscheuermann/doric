import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import prettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import variableSpacing from './eslint-rules/variable-spacing.mjs';

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

const variableStatement = {
  selector:
    'VariableDeclaration, ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
};

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
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['**/*.{ts,mts,cts}'],
    extends: [tseslint.configs.recommended],
  },
  {
    files: [
      '{packages,agents,bundles,tools,benchmarks}/*/{src,tests,tools}/**/*.ts',
    ],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: [
          './{packages,agents,bundles,tools,benchmarks}/*/tsconfig.{lib,app,spec,e2e}.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  prettier,
  {
    files: ['**/*.{js,mjs,cjs,ts,mts,cts}'],
    plugins: {
      '@stylistic': stylistic,
      'simple-import-sort': simpleImportSort,
      local: { rules: { 'variable-spacing': variableSpacing } },
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
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: '*', next: '*' },
        { blankLine: 'any', prev: 'import', next: 'import' },
        {
          blankLine: 'any',
          prev: variableStatement,
          next: variableStatement,
        },
      ],
      'local/variable-spacing': 'error',
      curly: ['error', 'all'],
      'no-nested-ternary': 'error',
      complexity: ['warn', 8],
      'max-depth': ['warn', 3],
      'max-params': ['warn', 3],
    },
  },
);
