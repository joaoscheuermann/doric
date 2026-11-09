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
  test('is 1.5.0 once the row and tab menus of the panels join the platform', () => {
    assert.equal(PLATFORM_VERSION, '1.5.0');
  });

  test('leaves the folders and URLs at 1.0.0', () => {
    assert.equal(PLATFORM_ASSETS_VERSION, '1.0.0');
  });
});

describe('the platform each bundle asks for', () => {
  test('chat and layout ask for ^1.1.0 and every other bundle for ^1.0.0', () => {
    const onMinorOne = new Set(['desktop/chat', 'desktop/layout']);
    const found = manifests();
    for (const name of onMinorOne) {
      assert.ok(found.has(name), [...found.keys()].join(', '));
    }
    assert.ok(found.size > onMinorOne.size, [...found.keys()].join(', '));

    for (const [name, manifest] of found) {
      assert.equal(
        manifest.engines?.doric,
        onMinorOne.has(name) ? '^1.1.0' : '^1.0.0',
        name,
      );
    }
  });
});
