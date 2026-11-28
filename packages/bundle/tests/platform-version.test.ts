// The platform version and the version of its folders and URLs. The platform
// rises a minor per phase that adds to it, while the folders and URLs stay
// where they were; a bundle that needs the addition asks for the new minor.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PLATFORM_ASSETS_VERSION, PLATFORM_VERSION } from '../src/index.js';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Every bundle manifest under `bundles/<group>/<name>/manifest.json`, by `<group>/<name>`. */
const manifests = (): Map<string, { engines?: { doric?: string } }> => {
  const bundles = join(repositoryRoot, 'bundles');
  const found = new Map<string, { engines?: { doric?: string } }>();
  for (const group of readdirSync(bundles, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    for (const bundle of readdirSync(join(bundles, group.name), {
      withFileTypes: true,
    })) {
      if (!bundle.isDirectory()) continue;
      const path = join(bundles, group.name, bundle.name, 'manifest.json');
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        continue;
      }
      found.set(`${group.name}/${bundle.name}`, JSON.parse(text));
    }
  }
  return found;
};

describe('the platform version', () => {
  test('is 1.12.0 once doric.appearance/v1 answers and saves glass', () => {
    assert.equal(PLATFORM_VERSION, '1.12.0');
  });

  test('leaves the folders and URLs at 1.0.0', () => {
    assert.equal(PLATFORM_ASSETS_VERSION, '1.0.0');
  });
});

describe('the platform each bundle asks for', () => {
  test('chat, files, terminal, threads and default ask for ^1.10.0, settings for ^1.9.0, layout, account and workspace for ^1.8.0, claude-login for ^1.7.0 and every other bundle for ^1.0.0', () => {
    const asked = new Map([
      ['desktop/chat', '^1.10.0'],
      ['features/files', '^1.10.0'],
      ['features/terminal', '^1.10.0'],
      ['features/threads', '^1.10.0'],
      ['runtime/default', '^1.10.0'],
      ['desktop/settings', '^1.9.0'],
      ['desktop/layout', '^1.8.0'],
      ['desktop/account', '^1.8.0'],
      ['desktop/workspace', '^1.8.0'],
      ['features/claude-login', '^1.7.0'],
    ]);
    const found = manifests();
    for (const name of asked.keys()) {
      assert.ok(found.has(name), [...found.keys()].join(', '));
    }
    assert.ok(found.size > asked.size, [...found.keys()].join(', '));

    for (const [name, manifest] of found) {
      assert.equal(manifest.engines?.doric, asked.get(name) ?? '^1.0.0', name);
    }
  });
});
