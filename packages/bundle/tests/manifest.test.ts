import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CompositionError,
  compositionSchema,
  convertV0,
  manifestV1Schema,
  readComposition,
  readManifest,
} from '../src/index.js';
import { parseManifest, rangeMajor, satisfies } from '../src/runtime/index.js';
import { manifest, withRoot, writeBundle } from './support/fixtures.js';

const valid = manifest('git', {
  version: '1.4.0',
  provides: ['git.commands/v1@1.3.0', 'git.hooks/v1@1.0.0'],
  requires: ['tools/v1@^1.0.0', 'runtime.lease/v1@^1.0.0'],
  description: 'Git capabilities.',
});

void test('accepts the documented v1 manifest and defaults provides and requires', () => {
  assert.equal(manifestV1Schema.safeParse(valid).success, true);

  const minimal = manifestV1Schema.parse({
    manifestVersion: 1,
    id: 'files',
    version: '1.0.0',
    engines: { doric: '^1.0.0' },
  });

  assert.deepEqual([minimal.provides, minimal.requires], [[], []]);
});

void test('rejects v1 manifests that break the contract-entry rules', () => {
  const cases: Record<string, unknown> = {
    'provides major differs from the ID': {
      ...valid,
      provides: ['git.commands/v1@2.0.0'],
    },
    'requires range admits another major': {
      ...valid,
      requires: ['tools/v1@^2.0.0'],
    },
    'requires range admits several majors': {
      ...valid,
      requires: ['tools/v1@>=1.0.0'],
    },
    'provides a range instead of a version': {
      ...valid,
      provides: ['git.commands/v1@^1.0.0'],
    },
    'declares a platform contract': {
      ...valid,
      requires: ['doric.catalog/v1@^1.0.0'],
    },
    'lists a contract twice': {
      ...valid,
      requires: ['tools/v1@^1.0.0', 'tools/v1@^1.2.0'],
    },
    'has an unknown key': { ...valid, tools: [] },
    'uses the platform ID': { ...valid, id: 'doric' },
    'uses an ID with dots': { ...valid, id: 'doric.git' },
    'has an invalid version': { ...valid, version: '1.0' },
    'has an invalid engines range': { ...valid, engines: { doric: 'latest' } },
  };

  for (const [name, document] of Object.entries(cases)) {
    assert.equal(manifestV1Schema.safeParse(document).success, false, name);
  }
});

void test('accepts bundle IDs that only start with "doric"', () => {
  assert.equal(
    manifestV1Schema.safeParse({ ...valid, id: 'doric-tools' }).success,
    true,
  );
});

void test('converts a v0 manifest in memory without assigning a product identity', () => {
  const converted = convertV0({
    name: 'core',
    description: 'Core capabilities.',
    tools: [{ path: 'tools/cwd.js', alwaysAvailable: true }],
    skills: [{ path: 'skills/a/SKILL.md', alwaysAvailable: false }],
  });

  assert.equal(converted.manifest.id, 'core');
  assert.equal(converted.manifest.version, '0.0.0');
  assert.deepEqual(converted.manifest.provides, []);
  assert.deepEqual(converted.manifest.requires, ['tools/v1@^1.0.0']);
  assert.equal(satisfies('1.0.0', converted.manifest.engines.doric), true);
  assert.deepEqual(converted.legacy?.tools, [
    { path: 'tools/cwd.js', alwaysAvailable: true },
  ]);
  assert.deepEqual(converted.legacy?.skills, [
    { path: 'skills/a/SKILL.md', alwaysAvailable: false },
  ]);

  const withoutTools = convertV0({
    name: 'threads',
    description: 'Delegation.',
    tools: [],
    skills: [],
  });

  assert.equal(withoutTools.manifest.id, 'threads');
  assert.deepEqual(withoutTools.manifest.requires, []);
});

void test('rejects a v0 name that is not a bundle ID', () => {
  assert.throws(() =>
    convertV0({ name: 'Not An Id', description: 'x', tools: [], skills: [] }),
  );
});

void test('recognizes v1 by manifestVersion and reads v0 otherwise', () => {
  assert.equal(parseManifest(valid).legacy, undefined);
  assert.notEqual(
    parseManifest({ name: 'git', description: 'x', tools: [], skills: [] })
      .legacy,
    undefined,
  );
  assert.throws(() => parseManifest({ name: 'git', description: 'x' }));
});

void test('reads manifests from disk with contextual errors', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'git', { manifest: valid });

    assert.equal((await readManifest(dir)).manifest.id, 'git');

    const broken = await writeBundle(root, 'broken', {
      manifest: { ...valid, id: 'Bad' },
    });

    await assert.rejects(readManifest(broken), /Invalid manifest/);
  });
});

void test('evaluates restricted semver ranges', () => {
  const cases: [string, string, boolean][] = [
    ['1.4.0', '^1.4.0', true],
    ['1.3.0', '^1.4.0', false],
    ['2.0.0', '^1.4.0', false],
    ['1.4.9', '~1.4.0', true],
    ['1.5.0', '~1.4.0', false],
    ['0.0.0', '*', true],
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '>=1.2.3 <1.3.0', true],
    ['1.3.0', '>=1.2.3 <1.3.0', false],
    ['3.0.0', '^1.0.0 || ^3.0.0', true],
    ['1.5.0-beta.1', '^1.0.0', false],
    ['1.5.0-beta.2', '>=1.5.0-beta.1', true],
  ];

  for (const [version, range, expected] of cases) {
    assert.equal(satisfies(version, range), expected, `${version} ${range}`);
  }

  assert.equal(rangeMajor('^1.2.0'), 1);
  assert.equal(rangeMajor('>=1.0.0 <2.0.0'), 1);
  assert.equal(rangeMajor('1.0.0'), 1);
  assert.equal(rangeMajor('>=1.0.0'), undefined);
  assert.equal(rangeMajor('*'), undefined);
  assert.equal(rangeMajor('^1.0.0 || ^2.0.0'), undefined);
});

void test('validates compositions strictly', () => {
  assert.deepEqual(
    compositionSchema.parse({ core: 'core', enabled: ['core'] }).providers,
    {},
  );

  for (const document of [
    { enabled: ['core'] },
    { core: 'core', enabled: [] },
    { core: 'core', enabled: ['core'], providers: { 'not a contract': 'x' } },
    { core: 'core', enabled: ['core'], windows: [] },
  ]) {
    assert.equal(compositionSchema.safeParse(document).success, false);
  }
});

void test('reports an unreadable composition as a CompositionError', async () => {
  await withRoot(async (root) => {
    await assert.rejects(
      readComposition(`${root}/missing.json`),
      (error: unknown) => error instanceof CompositionError,
    );
  });
});
