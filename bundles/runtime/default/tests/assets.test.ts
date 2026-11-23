import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { builtInAgentFiles } from '../src/host/agents/built-in.js';
import {
  assetText,
  defaultAssetPaths,
  loadAssetTexts,
  useAssetTexts,
} from '../src/host/assets.js';
import { systemPromptWith } from '../src/host/executor.js';
import { checkTemplate, lazyTemplate } from '../src/host/prompts/templates.js';
import { harnessVariables } from './support/harness.js';

/*
 * The texts the host part reads (templates and built-in agents) come from one
 * process-wide source, read on first use: the texts installed with
 * `useAssetTexts` (the host part, from `host.assets`), else the file beside the
 * module. The tests below that fall back to disk run first; later ones install
 * texts and put the full set back when they end.
 */

/**
 * The test target compiles to bundles/runtime/default/dist-tests/tests; the
 * bundle directory, holding `src/host/**`, is two folders above.
 */
const bundleDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `*.md` files of `src/host/<folder>`, as bundle-relative paths, sorted. */
const markdownIn = (folder: string): readonly string[] =>
  readdirSync(join(bundleDir, 'src', 'host', folder))
    .filter((name) => name.endsWith('.md'))
    .sort()
    .map((name) => `src/host/${folder}/${name}`);

const promptPaths = markdownIn('prompts');
const agentPaths = markdownIn('agents');

/** The text of a bundle-relative path, as on disk. */
const onDisk = (path: string): string =>
  readFileSync(join(bundleDir, path), 'utf8');

/** Every asset's text as on disk, by bundle-relative path. */
const diskTexts = (): Map<string, string> =>
  new Map([...promptPaths, ...agentPaths].map((path) => [path, onDisk(path)]));

/** The built-in agents, in workflow order (the order `default.agents/v1` lists them). */
const workflow = [
  'triage',
  'search',
  'spec',
  'review',
  'plan',
  'contracts',
  'tests',
  'implementation',
  'cleanup',
  'docs',
];

const baseName = (path: string): string =>
  path.slice(path.lastIndexOf('/') + 1);

void test('C3 defaultAssetPaths names the prompts, then the built-in agents: exactly the *.md files of src/host/prompts and src/host/agents', () => {
  assert.equal(promptPaths.length, 7);
  assert.equal(agentPaths.length, 10);

  assert.deepEqual(
    [...defaultAssetPaths].sort(),
    [...promptPaths, ...agentPaths].sort(),
  );
  assert.deepEqual(
    defaultAssetPaths.slice(0, promptPaths.length).sort(),
    promptPaths,
  );
  assert.equal(new Set(defaultAssetPaths).size, defaultAssetPaths.length);
});

void test('C3 every asset path matches one of the host.assets globs src/host/prompts/*.md and src/host/agents/*.md', () => {
  assert.ok(defaultAssetPaths.length > 0);
  for (const path of defaultAssetPaths) {
    assert.match(path, /^src\/host\/(prompts|agents)\/[^/]+\.md$/u);
  }
});

void test('C7 builtInAgentFiles() answers the ten shipped agent files in workflow order, each with its text', () => {
  const files = builtInAgentFiles();

  assert.deepEqual(
    files.map(({ path }) => baseName(path)),
    workflow.map((name) => `${name}.md`),
  );
  assert.deepEqual(
    files.map(({ text }) => text),
    workflow.map((name) => onDisk(`src/host/agents/${name}.md`)),
  );
});

void test('assetText reads an asset from the file beside the module when no texts are installed', () => {
  assert.equal(
    assetText('src/host/prompts/system.md'),
    onDisk('src/host/prompts/system.md'),
  );
  assert.equal(
    assetText('src/host/agents/triage.md'),
    onDisk('src/host/agents/triage.md'),
  );
});

void test('lazyTemplate reads nothing when made, then answers the checked template on its first call', () => {
  const path = 'src/host/prompts/agent.md';
  const names = ['name', 'instructions'];

  const template = lazyTemplate(path, names);

  assert.equal(template(), checkTemplate(onDisk(path), names, path));
});

void test('lazyTemplate of a missing file throws at the call, never when made', () => {
  const template = lazyTemplate('src/host/prompts/missing.md', []);

  assert.throws(template, /missing\.md/u);
});

void test('loadAssetTexts reads every asset path through read, in order, and decodes each as UTF-8', async () => {
  const read: string[] = [];

  const texts = await loadAssetTexts(async (path) => {
    read.push(path);
    return new TextEncoder().encode(`text of ${path} — ü`);
  });

  assert.ok(defaultAssetPaths.length > 0);
  assert.deepEqual(read, [...defaultAssetPaths]);
  assert.deepEqual(
    [...texts],
    defaultAssetPaths.map((path) => [path, `text of ${path} — ü`]),
  );
});

void test('loadAssetTexts rejects with the error of the first read that fails', async () => {
  const failure = new Error('src/host/prompts/agents.md is not listed');

  await assert.rejects(
    loadAssetTexts(async (path) => {
      if (path === defaultAssetPaths[1]) throw failure;
      return new TextEncoder().encode('text');
    }),
    (error: unknown) => error === failure,
  );
});

void test('C2 systemPromptWith renders the installed system.md on its next call', (t) => {
  t.after(() => useAssetTexts(diskTexts()));
  const texts = diskTexts();
  texts.set('src/host/prompts/system.md', 'The installed system prompt.\n');

  useAssetTexts(texts);

  assert.equal(
    systemPromptWith(harnessVariables, ''),
    'The installed system prompt.',
  );
  assert.equal(
    systemPromptWith(harnessVariables, '# Agent: tests'),
    'The installed system prompt.\n\n# Agent: tests',
  );
});

void test('C2 a later useAssetTexts replaces the source: templates and agent files are read again from it', (t) => {
  t.after(() => useAssetTexts(diskTexts()));
  const first = diskTexts();
  first.set('src/host/prompts/agent.md', 'First {{name}}.\n');
  const second = diskTexts();
  second.set('src/host/prompts/agent.md', 'Second {{name}}.\n');
  second.set('src/host/agents/triage.md', 'Installed triage.\n');
  const template = lazyTemplate('src/host/prompts/agent.md', [
    'name',
    'instructions',
  ]);

  useAssetTexts(first);
  assert.equal(template(), 'First {{name}}.');

  useAssetTexts(second);
  assert.equal(template(), 'Second {{name}}.');
  assert.equal(assetText('src/host/agents/triage.md'), 'Installed triage.\n');
  assert.equal(builtInAgentFiles()[0]?.text, 'Installed triage.\n');
});

void test('C2 with installed texts lacking system.md, the first render throws an Error naming the path', (t) => {
  t.after(() => useAssetTexts(diskTexts()));
  const texts = diskTexts();
  texts.delete('src/host/prompts/system.md');

  useAssetTexts(texts);

  assert.throws(
    () => systemPromptWith(harnessVariables, ''),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('src/host/prompts/system.md'),
  );
  assert.throws(
    () => assetText('src/host/prompts/system.md'),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('src/host/prompts/system.md'),
  );
});
