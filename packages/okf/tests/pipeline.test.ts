import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { hasRecipeHash, renderConcept } from '../src/lib/concept.js';
import {
  PARSER_DEPENDENCY_VERSIONS,
  PARSER_VERSION,
} from '../src/lib/interface.js';
import {
  RECIPE_VERSIONS,
  recipeHash,
  type RecipeVersions,
  YAML_DEPENDENCY_VERSION,
} from '../src/lib/recipe.js';
import { renderEvidence } from '../src/lib/summarize.js';
import { createProvider } from './fakes.js';

test('renders collision-safe evidence with exact source and interface YAML', () => {
  const content = '````\n~~~~~~~~\nconst pattern = /a\\/b/g;\n';

  const rendered = renderEvidence({
    path: 'src/main.ts',
    type: 'ts',
    interface: {
      imports: {
        relative: [{ source: './dep', target: null, symbols: ['Foo as Bar'] }],
      },
    },
    content,
  });

  assert.match(rendered, /^# File Evidence/u);

  assert.match(rendered, /## Module Interface\n\n```yaml/u);

  assert.ok(rendered.includes('target: null'));

  assert.ok(rendered.includes(content));

  assert.ok(rendered.includes('/a\\/b/g'));

  assert.equal(extractFramedContent(rendered), content);

  assert.match(rendered, /UTF-8 bytes: 39/u);

  assert.match(rendered, /Terminal newline: yes/u);
});

test('frames JSON and no-terminal-newline content losslessly', () => {
  const content = '{"label":"olá"}';

  const rendered = renderEvidence({
    path: 'data.json',
    type: 'json',
    content,
  });

  assert.match(rendered, /Terminal newline: no/u);

  assert.match(rendered, /```json\n\{"label":"olá"\}\n```/u);

  assert.equal(extractFramedContent(rendered), content);
});

test('hashes source metadata relationships prompt provider model and effort', () => {
  const hashInput = (value: unknown): string =>
    recipeHash(value as Parameters<typeof recipeHash>[0]);
  const first = createProvider().provider;

  const second = {
    ...first,
    metadata: { ...first.metadata, id: 'second' },
  };

  const base = {
    config: { provider: first, model: 'model', effort: 'low' as const },
    content: 'export const value = 1;',
    interface: { exports: { variables: ['value'] } },
    path: 'src/value.ts',
    prompts: {
      summary: 'Summary prompt one',
      description: 'Description prompt one',
      tags: 'Tags prompt one',
    },
    promptTarget: 'default',
    type: 'ts',
  };
  const hash = hashInput(base);

  const variations = [
    { ...base, content: 'export const value = 2;' },
    { ...base, path: 'src/other.ts' },
    { ...base, type: 'tsx' },
    { ...base, interface: { exports: { variables: ['other'] } } },
    {
      ...base,
      prompts: { ...base.prompts, summary: 'Summary prompt two' },
    },
    {
      ...base,
      prompts: { ...base.prompts, description: 'Description prompt two' },
    },
    {
      ...base,
      prompts: { ...base.prompts, tags: 'Tags prompt two' },
    },
    { ...base, promptTarget: 'optimized' },
    { ...base, config: { ...base.config, provider: second } },
    { ...base, config: { ...base.config, model: 'other' } },
    { ...base, config: { ...base.config, effort: 'high' as const } },
  ];

  assert.equal(hash.length, 64);

  variations.forEach((variation) =>
    assert.notEqual(hashInput(variation), hash),
  );

  for (const key of Object.keys(RECIPE_VERSIONS) as (keyof RecipeVersions)[]) {
    assert.notEqual(
      hashInput({
        ...base,
        versions: {
          ...RECIPE_VERSIONS,
          [key]: `${RECIPE_VERSIONS[key]}-changed`,
        },
      }),
      hash,
      key,
    );
  }

  assert.equal('pipeline' in RECIPE_VERSIONS, true);

  assert.equal(RECIPE_VERSIONS.plainTextFields, 'plain-text-fields-v4');

  assert.equal(RECIPE_VERSIONS.pipeline, 'summary-description-tags-v1');
});

test('pins parser grammar and YAML recipe versions to exact dependencies', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(
      path.join(process.cwd(), 'packages', 'okf', 'package.json'),
      'utf-8',
    ),
  ) as { readonly dependencies: Readonly<Record<string, string>> };

  for (const [name, version] of Object.entries(PARSER_DEPENDENCY_VERSIONS)) {
    assert.equal(packageJson.dependencies[name], version, name);
  }

  assert.equal(packageJson.dependencies.yaml, YAML_DEPENDENCY_VERSION);

  assert.equal(
    PARSER_VERSION,
    `${Object.entries(PARSER_DEPENDENCY_VERSIONS)
      .map(([name, version]) => `${name}@${version}`)
      .join('|')}|buffer-next-power-of-two-v1`,
  );
});

test('renders flow scalar arrays and compares only parsed exact hashes', () => {
  const markdown = renderConcept({
    source: 'src/main.ts',
    type: 'ts',
    description: 'Provides a module.',
    tags: ['source-code', 'typescript'],
    analysis: '# Analysis',
    timestamp: '2026-07-22T12:00:00.000Z',
    hash: 'abc123',
    interface: {
      imports: {
        relative: [{ source: './dep', target: null, symbols: ['Foo'] }],
      },
      exports: { functions: ['create(): Value'] },
    },
  });

  assert.match(markdown, /tags: \[ "source-code", "typescript" \]/u);

  assert.match(markdown, /symbols: \[ "Foo" \]/u);

  assert.match(markdown, /functions: \[ "create\(\): Value" \]/u);

  assert.equal(hasRecipeHash(markdown, 'abc123'), true);

  assert.equal(hasRecipeHash(markdown, 'abc'), false);

  assert.equal(
    hasRecipeHash(markdown.replace('abc123', 'abc123-extra'), 'abc123'),
    false,
  );

  assert.equal(hasRecipeHash('---\nhash: [invalid\n---\n', 'abc123'), false);
});

const extractFramedContent = (rendered: string): string => {
  const match =
    /## Content\n\nUTF-8 bytes: (\d+)\n\nTerminal newline: (?:yes|no)\n\n(?:`{3,}|~{3,})(?:json|text)\n/gu.exec(
      rendered,
    );

  assert.ok(match);

  const start = (match.index ?? 0) + match[0].length;

  return Buffer.from(rendered.slice(start), 'utf-8')
    .subarray(0, Number(match[1]))
    .toString('utf-8');
};
