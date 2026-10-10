import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { activated } from './support/services.js';

void test('registers only the always-available web tool at position 700', async () => {
  const registered = await activated();

  assert.deepEqual(
    registered.map(({ tool, options }) => ({ name: tool.name, options })),
    [{ name: 'web', options: { alwaysAvailable: true, order: 700 } }],
  );
});

void test('the registered web tool answers a prompt call with the established description', async () => {
  const [entry] = await activated();

  assert.equal(
    entry?.bound.description,
    'Search the web, open HTTP(S) pages as extracted text, or find literal text in a page.',
  );

  const result = (await entry?.bound.execute({
    action: 'search',
    query: ' ',
  })) as { readonly error?: string } | undefined;

  assert.equal(result?.error, 'Missing query for search');
});

void test('ships the web-research skill at position 1200, allowing only the web tool', async () => {
  const body = await readFile(
    'bundles/web/src/skills/web-research/SKILL.md',
    'utf8',
  );
  const frontmatter = body.split('---')[1] ?? '';

  assert.match(frontmatter, /^name: web-research$/mu);

  assert.match(frontmatter, /^allowed-tools:\n {2}- web$/mu);

  assert.match(frontmatter, /^order: 1200$/mu);
});
