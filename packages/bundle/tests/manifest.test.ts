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
import {
  hostAssetsOf,
  httpPrefixOf,
  httpPrefixPattern,
  manifestV2Schema,
  parseManifest,
  partLists,
  rangeMajor,
  satisfies,
} from '../src/runtime/index.js';
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

/** The `files` example of the spec's "Requirements per part". */
const filesV2 = {
  manifestVersion: 2,
  id: 'files',
  version: '2.0.0',
  engines: { doric: '^2.0.0' },
  description: 'Core capabilities available to the Doric agent.',
  provides: [
    'files/v1@1.4.0',
    'files.sandbox/v1@1.1.0',
    'files.refresh/v1@1.1.0',
    'files.open-file/v1@1.1.0',
  ],
  host: {
    requires: [
      'tools/v1@^1.4.0',
      'runtime.workspace/v1@^1.2.0',
      'runtime.lease/v1@^1.2.0',
      'runtime.attachments/v1@^1.0.0',
    ],
  },
  client: {
    requires: [
      'ui/v1@^1.0.0',
      'regions/v1@^1.0.0',
      'commands/v1@^1.0.0',
      'workspace.selection/v1@^1.0.0',
      'runtime.records/v1@^1.0.0',
      'layout.panel/v3@^3.0.0',
      'layout.tabs/v2@^2.0.0',
    ],
    optional: ['files.decorations/v1', 'chat.activity/v1', 'chat.views/v1'],
  },
  desktopScope: { 'files/v1': ['projectId', 'threadId', 'promptId'] },
};

const minimalV2 = {
  manifestVersion: 2,
  id: 'files',
  version: '2.0.0',
  engines: { doric: '^2.0.0' },
};

const entry = (id: string, major: number, spec: string) => ({
  id,
  major,
  spec,
});

void test('accepts the spec files example as a v2 manifest and answers each part its own lists', () => {
  assert.equal(manifestV2Schema.safeParse(filesV2).success, true);

  const { manifest: parsed } = parseManifest(filesV2);

  assert.equal(parsed.manifestVersion, 2);
  assert.deepEqual(partLists(parsed, 'host'), {
    requires: [
      entry('tools/v1', 1, '^1.4.0'),
      entry('runtime.workspace/v1', 1, '^1.2.0'),
      entry('runtime.lease/v1', 1, '^1.2.0'),
      entry('runtime.attachments/v1', 1, '^1.0.0'),
    ],
    optional: [],
  });
  assert.deepEqual(partLists(parsed, 'client'), {
    requires: [
      entry('ui/v1', 1, '^1.0.0'),
      entry('regions/v1', 1, '^1.0.0'),
      entry('commands/v1', 1, '^1.0.0'),
      entry('workspace.selection/v1', 1, '^1.0.0'),
      entry('runtime.records/v1', 1, '^1.0.0'),
      entry('layout.panel/v3', 3, '^3.0.0'),
      entry('layout.tabs/v2', 2, '^2.0.0'),
    ],
    optional: ['files.decorations/v1', 'chat.activity/v1', 'chat.views/v1'],
  });
});

void test('v2 part objects are optional and default to empty lists', () => {
  const parsed = manifestV2Schema.parse(minimalV2);

  assert.deepEqual(parsed.host, { requires: [], optional: [] });
  assert.deepEqual(parsed.client, { requires: [], optional: [] });
  assert.deepEqual(parsed.provides, []);

  const read = parseManifest(minimalV2).manifest;

  for (const part of ['host', 'client'] as const) {
    assert.deepEqual(partLists(read, part), { requires: [], optional: [] });
  }

  const hostOnly = parseManifest({
    ...minimalV2,
    host: { requires: ['tools/v1@^1.0.0'] },
  }).manifest;

  assert.deepEqual(partLists(hostOnly, 'host'), {
    requires: [entry('tools/v1', 1, '^1.0.0')],
    optional: [],
  });
  assert.deepEqual(partLists(hostOnly, 'client'), {
    requires: [],
    optional: [],
  });
});

void test('accepts the same contract in both parts of a v2 manifest', () => {
  assert.equal(
    manifestV2Schema.safeParse({
      ...minimalV2,
      host: { requires: ['tools/v1@^1.0.0'] },
      client: { requires: ['tools/v1@^1.0.0'], optional: [] },
    }).success,
    true,
  );
});

void test('rejects v2 manifests that break the per-part rules', () => {
  const cases: Record<string, unknown> = {
    'a doric.* id under host.requires': {
      ...minimalV2,
      host: { requires: ['doric.catalog/v1@^1.0.0'] },
    },
    'a doric.* id under client.optional': {
      ...minimalV2,
      client: { optional: ['doric.windows/v1'] },
    },
    'a doric.* id under host.optional': {
      ...minimalV2,
      host: { optional: ['doric.catalog/v1'] },
    },
    'an id under both requires and optional of the host part': {
      ...minimalV2,
      host: { requires: ['tools/v1@^1.0.0'], optional: ['tools/v1'] },
    },
    'an id under both requires and optional of the client part': {
      ...minimalV2,
      client: { requires: ['ui/v1@^1.0.0'], optional: ['ui/v1'] },
    },
    'an id twice under client.requires': {
      ...minimalV2,
      client: { requires: ['ui/v1@^1.0.0', 'ui/v1@^1.2.0'] },
    },
    'an id twice under host.optional': {
      ...minimalV2,
      host: { optional: ['chat.views/v1', 'chat.views/v1'] },
    },
    'a requires range admitting another major': {
      ...minimalV2,
      client: { requires: ['ui/v1@^2.0.0'] },
    },
    'a requires range admitting several majors': {
      ...minimalV2,
      host: { requires: ['tools/v1@>=1.0.0'] },
    },
    'top-level requires': { ...minimalV2, requires: ['tools/v1@^1.0.0'] },
    'top-level optional': { ...minimalV2, optional: ['tools/v1'] },
    'an unknown top-level key': { ...minimalV2, tools: [] },
    'an unknown host key': { ...minimalV2, host: { services: [] } },
    'an unknown client key': {
      ...minimalV2,
      client: { httpPrefix: '/screen/' },
    },
    'provides major differs from the ID': {
      ...minimalV2,
      provides: ['files/v1@2.0.0'],
    },
    'uses the platform ID': { ...minimalV2, id: 'doric' },
    'has an invalid version': { ...minimalV2, version: '2.0' },
  };

  for (const [name, document] of Object.entries(cases)) {
    assert.equal(manifestV2Schema.safeParse(document).success, false, name);
    assert.throws(() => parseManifest(document), name);
  }
});

void test('accepts host.httpPrefix of one segment between slashes in v1 and v2', () => {
  assert.equal(httpPrefixPattern.test('/screen/'), true);
  assert.equal(
    manifestV1Schema.safeParse({ ...valid, host: { httpPrefix: '/screen/' } })
      .success,
    true,
  );
  assert.equal(
    manifestV2Schema.safeParse({
      ...minimalV2,
      host: { httpPrefix: '/screen/' },
    }).success,
    true,
  );

  for (const prefix of ['/a/b/', 'screen']) {
    assert.equal(httpPrefixPattern.test(prefix), false, prefix);
    assert.equal(
      manifestV1Schema.safeParse({ ...valid, host: { httpPrefix: prefix } })
        .success,
      false,
      `v1 ${prefix}`,
    );
    assert.equal(
      manifestV2Schema.safeParse({
        ...minimalV2,
        host: { httpPrefix: prefix },
      }).success,
      false,
      `v2 ${prefix}`,
    );
  }

  assert.equal(
    manifestV1Schema.safeParse({ ...valid, host: { requires: [] } }).success,
    false,
    'v1 host holds httpPrefix only',
  );
});

void test('httpPrefixOf answers host.httpPrefix of either version, or undefined', () => {
  assert.equal(
    httpPrefixOf(
      parseManifest({ ...valid, host: { httpPrefix: '/screen/' } }).manifest,
    ),
    '/screen/',
  );
  assert.equal(
    httpPrefixOf(
      parseManifest({ ...minimalV2, host: { httpPrefix: '/screen/' } })
        .manifest,
    ),
    '/screen/',
  );
  assert.equal(httpPrefixOf(parseManifest(valid).manifest), undefined);
  assert.equal(
    httpPrefixOf(parseManifest({ ...valid, host: {} }).manifest),
    undefined,
  );
  assert.equal(httpPrefixOf(parseManifest(filesV2).manifest), undefined);
});

void test('accepts host.assets in v1 and v2 and hostAssetsOf answers them in order', () => {
  const assets = ['src/host/skills/*.md', 'dist/sandbox/runner.mjs'];

  assert.deepEqual(
    hostAssetsOf(parseManifest({ ...valid, host: { assets } }).manifest),
    assets,
  );
  assert.deepEqual(
    hostAssetsOf(parseManifest({ ...minimalV2, host: { assets } }).manifest),
    assets,
  );
});

void test('hostAssetsOf answers [] when the manifest sets no host.assets', () => {
  assert.deepEqual(hostAssetsOf(parseManifest(valid).manifest), []);
  assert.deepEqual(
    hostAssetsOf(parseManifest({ ...valid, host: {} }).manifest),
    [],
  );
  assert.deepEqual(hostAssetsOf(parseManifest(minimalV2).manifest), []);
});

void test('refuses host.assets globs that are not relative, normal and "/"-separated', () => {
  const refused = [
    '',
    '/abs/*.md',
    '../x',
    'src/../x',
    './src/x',
    'src//x',
    'src\\x',
  ];

  for (const glob of refused) {
    for (const [version, schema, base] of [
      ['v1', manifestV1Schema, valid],
      ['v2', manifestV2Schema, minimalV2],
    ] as const) {
      const result = schema.safeParse({ ...base, host: { assets: [glob] } });

      assert.equal(result.success, false, `${version} ${JSON.stringify(glob)}`);
      assert.deepEqual(
        [
          ...new Set(
            result.error?.issues.map((issue) => JSON.stringify(issue.path)),
          ),
        ],
        [JSON.stringify(['host', 'assets', 0])],
        `${version} ${JSON.stringify(glob)}`,
      );
    }
  }
});

void test('v2 refuses client.assets', () => {
  assert.equal(
    manifestV2Schema.safeParse({
      ...minimalV2,
      client: { assets: ['src/client/*.css'] },
    }).success,
    false,
  );
});

void test('a v1 manifest answers its bundle-wide lists for both parts', () => {
  const { manifest: parsed } = parseManifest({
    ...valid,
    optional: ['chat.views/v1'],
  });

  assert.equal(parsed.manifestVersion, 1);

  for (const part of ['host', 'client'] as const) {
    assert.deepEqual(
      partLists(parsed, part),
      {
        requires: [
          entry('tools/v1', 1, '^1.0.0'),
          entry('runtime.lease/v1', 1, '^1.0.0'),
        ],
        optional: ['chat.views/v1'],
      },
      part,
    );
  }

  for (const part of ['host', 'client'] as const) {
    assert.deepEqual(
      partLists(parseManifest(valid).manifest, part),
      {
        requires: [
          entry('tools/v1', 1, '^1.0.0'),
          entry('runtime.lease/v1', 1, '^1.0.0'),
        ],
        optional: [],
      },
      `${part} without optional`,
    );
  }
});

void test('converts a v0 manifest in memory without assigning a product identity', () => {
  const converted = convertV0({
    name: 'core',
    description: 'Core capabilities.',
    tools: [{ path: 'tools/cwd.js', alwaysAvailable: true }],
    skills: [{ path: 'skills/a/SKILL.md', alwaysAvailable: false }],
  });

  assert.ok(converted.manifest.manifestVersion === 1);
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

  assert.ok(withoutTools.manifest.manifestVersion === 1);
  assert.equal(withoutTools.manifest.id, 'threads');
  assert.deepEqual(withoutTools.manifest.requires, []);
});

void test('rejects a v0 name that is not a bundle ID', () => {
  assert.throws(() =>
    convertV0({ name: 'Not An Id', description: 'x', tools: [], skills: [] }),
  );
});

void test('recognizes v1 and v2 by manifestVersion and reads v0 otherwise', () => {
  assert.equal(parseManifest(valid).legacy, undefined);
  assert.equal(parseManifest(valid).manifest.manifestVersion, 1);
  assert.equal(parseManifest(filesV2).legacy, undefined);
  assert.equal(parseManifest(filesV2).manifest.manifestVersion, 2);
  assert.throws(() => parseManifest({ ...filesV2, manifestVersion: 3 }));
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
