import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';

import {
  diffViolations,
  findCore,
  findCycles,
  findDeclared,
  findDependencies,
  findImports,
  findLists,
  isSourcePathImport,
} from './support/boundaries.mjs';
import {
  importedModules,
  root,
  sourceFiles,
  workspacePackageNames,
} from './support/workspace.mjs';

const at = (path, source) => ({ path, source });

const finding = (check, bundle, target) => ({ check, bundle, target });

const entry = (check, bundle, target, decision = 'docs/decision.md') => ({
  check,
  bundle,
  target,
  decision,
});

const bundle = (
  id,
  { group = 'features', packageJson = {}, ...manifest } = {},
) => ({
  id,
  directory: `bundles/${group}/${id}`,
  manifest: { id, provides: [], ...manifest },
  packageJson: { name: id, ...packageJson },
});

const snapshot = (parts = {}) => ({
  files: [],
  packages: [],
  packageDirectories: {},
  bundles: [],
  buildFiles: [],
  composition: {},
  ...parts,
});

const clean = { components: [], unknown: [], unneeded: [] };

// T0.1, workspace.mjs

test('1. sourceFiles lists tracked and untracked sources and leaves out ignored, dist, node_modules, non-source and deleted files', () => {
  const repository = realpathSync(
    mkdtempSync(join(tmpdir(), 'boundaries-sources-')),
  );
  const write = (path, text = 'export {};\n') => {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), text);
  };
  const git = (...args) =>
    execFileSync('git', args, { cwd: repository, stdio: 'pipe' });

  try {
    git('init', '--quiet');
    write('.gitignore', 'src/ignored.ts\n');
    write('src/tracked.ts');
    write('src/distribution.ts');
    write('src/deleted.ts');
    git('add', '.gitignore', 'src/tracked.ts', 'src/distribution.ts');
    git('add', 'src/deleted.ts');
    unlinkSync(join(repository, 'src/deleted.ts'));
    write('src/untracked.js');
    write('src/ignored.ts');
    write('dist/out.js');
    write('dist-e2e/x.js');
    write('node_modules/pkg/index.js');
    write('src/notes.md', '# Notes\n');

    const expected = [
      join(repository, 'src', 'distribution.ts'),
      join(repository, 'src', 'tracked.ts'),
      join(repository, 'src', 'untracked.js'),
    ];

    assert.deepEqual(sourceFiles(repository, repository), expected);
    assert.deepEqual(sourceFiles('src', repository), expected);
  } finally {
    rmSync(repository, { recursive: true, force: true });
  }
});

test('2. importedModules returns the specifier of each of the six forms', () => {
  const source = [
    "import { a } from 'from-form';",
    "const b = require( 'require-form');",
    "import 'bare-form';",
    "const c = await import( 'dynamic-form');",
    'const d = import.meta.resolve("meta-resolve-form");',
    "const e = require.resolve('require-resolve-form');",
    '',
  ].join('\n');

  assert.deepEqual(
    importedModules(source).sort(),
    [
      'bare-form',
      'dynamic-form',
      'from-form',
      'meta-resolve-form',
      'require-form',
      'require-resolve-form',
    ].sort(),
  );
  assert.deepEqual(importedModules('const value = 1;\n'), []);
});

// T0.1, imports

test('3. imports: a <package>/src/ import is a rule (1) finding that no entry excuses', () => {
  const findings = findImports(
    snapshot({
      packages: ['pkg', 'alpha', 'beta'],
      bundles: [bundle('alpha'), bundle('beta')],
      files: [
        at('packages/app/src/main.ts', "import { x } from 'pkg/src/x';\n"),
        at(
          'bundles/features/alpha/src/a.ts',
          "import { y } from 'beta/src/y';\n",
        ),
      ],
    }),
  );

  assert.deepEqual(findings, [
    finding('imports', 'bundles/features/alpha/src/a.ts', 'beta/src/y'),
    finding('imports', 'packages/app/src/main.ts', 'pkg/src/x'),
  ]);
  assert.equal(isSourcePathImport(findings[1]), true);
  assert.equal(
    isSourcePathImport(finding('imports', 'alpha', 'beta/host')),
    false,
  );
  assert.equal(isSourcePathImport(finding('core', 'a/b', 'x')), false);

  const listed = entry('imports', 'packages/app/src/main.ts', 'pkg/src/x');

  assert.deepEqual(
    diffViolations({
      findings: [findings[1]],
      entries: [listed],
      exists: () => true,
    }),
    { unlisted: [findings[1]], stale: [listed], undocumented: [] },
  );
});

const importsIn = (path, source) =>
  findImports(
    snapshot({
      packages: ['alpha', 'beta'],
      bundles: [bundle('alpha'), bundle('beta')],
      files: [at(path, source)],
    }),
  );

test("4. imports: a bundle src file importing another bundle's host is found, its contracts and the bundle's own subpaths are not", () => {
  assert.deepEqual(
    importsIn(
      'bundles/features/alpha/src/a.ts',
      [
        "import { host } from 'beta/host';",
        "import { BetaV1 } from 'beta/contracts';",
        "import { own } from 'alpha/host';",
        '',
      ].join('\n'),
    ),
    [finding('imports', 'alpha', 'beta/host')],
  );
});

test('5. imports: a dynamic import of another bundle is found', () => {
  assert.deepEqual(
    importsIn(
      'bundles/features/alpha/src/a.ts',
      "const host = await import('beta/host');\n",
    ),
    [finding('imports', 'alpha', 'beta/host')],
  );
});

test('6. imports: <other>/package.json passes in tests/ and is found in src/ and stories/', () => {
  const source = "const path = import.meta.resolve('beta/package.json');\n";

  assert.deepEqual(
    importsIn('bundles/features/alpha/tests/support/window.ts', source),
    [],
  );
  assert.deepEqual(importsIn('bundles/features/alpha/src/a.ts', source), [
    finding('imports', 'alpha', 'beta/package.json'),
  ]);
  assert.deepEqual(
    importsIn('bundles/features/alpha/stories/a.stories.tsx', source),
    [finding('imports', 'alpha', 'beta/package.json')],
  );
});

test('7. imports: <other>/testing passes in tests/ and stories/ and is found in src/', () => {
  const source = "import { fake } from 'beta/testing';\n";

  assert.deepEqual(
    importsIn('bundles/features/alpha/tests/a.test.ts', source),
    [],
  );
  assert.deepEqual(
    importsIn('bundles/features/alpha/stories/a.stories.tsx', source),
    [],
  );
  assert.deepEqual(importsIn('bundles/features/alpha/src/a.ts', source), [
    finding('imports', 'alpha', 'beta/testing'),
  ]);
});

test('7a. imports: <other>/contracts/gen/<path> passes in src/, tests/ and stories/', () => {
  const source =
    "import { ReadRequestSchema } from 'beta/contracts/gen/doric/beta/v1/beta_pb.js';\n";

  for (const path of [
    'bundles/features/alpha/src/a.ts',
    'bundles/features/alpha/tests/a.test.ts',
    'bundles/features/alpha/stories/a.stories.tsx',
  ]) {
    assert.deepEqual(importsIn(path, source), [], path);
  }
});

test('7b. imports: <other>/contracts/<file> outside gen/ is still found', () => {
  assert.deepEqual(
    importsIn(
      'bundles/features/alpha/src/a.ts',
      "import { BetaV1 } from 'beta/contracts/index.js';\n",
    ),
    [finding('imports', 'alpha', 'beta/contracts/index.js')],
  );
});

// T0.1, declared

const declaredIn = (alpha, source) =>
  findDeclared(
    snapshot({
      bundles: [
        bundle('beta', {
          provides: ['beta.thing/v1@1.0.0', 'doric.thing/v1@1.0.0'],
        }),
        bundle('alpha', { provides: ['alpha.own/v1@1.0.0'], ...alpha }),
      ],
      files: [at('bundles/features/alpha/src/use.ts', source)],
    }),
  );

test('8. declared: an undeclared literal id is found; declared, own, doric. and commented ids are not; an id in a backtick SQL template is found', () => {
  const literal = "export const id = 'beta.thing/v1';\n";
  const undeclared = [finding('declared', 'alpha', 'beta.thing/v1')];

  assert.deepEqual(declaredIn({}, literal), undeclared);
  assert.deepEqual(
    declaredIn({ optional: ['beta.thing/v1@^1.0.0'] }, literal),
    [],
  );
  assert.deepEqual(
    declaredIn({ requires: ['beta.thing/v1@^1.0.0'] }, literal),
    [],
  );
  assert.deepEqual(
    declaredIn(
      {},
      [
        "export const own = 'alpha.own/v1';",
        "export const platform = 'doric.thing/v1';",
        '// Reads "beta.thing/v1".',
        '/**',
        " * Reads 'beta.thing/v1'.",
        ' */',
        "/* 'beta.thing/v1' */",
        '',
      ].join('\n'),
    ),
    [],
  );
  assert.deepEqual(
    declaredIn({}, "await sql`INSERT INTO t (id) VALUES ('beta.thing/v1')`;\n"),
    undeclared,
  );
});

test('9. declared: each symbol form maps to its id, and an import of it is found', () => {
  const contracts = [
    "export const OneLineV1 = ref<OneLine>('beta.one-line/v1');",
    'export const MultiLineV1 = ref<MultiLine>(',
    "  'beta.multi-line/v1',",
    ');',
    "export const HooksV1 = defineHooks('beta.hooks/v1', {",
    '  started: hook<void>(),',
    '});',
    "export const StringV1 = 'beta.string/v1';",
    'export const EventsV1 = {',
    "  type: 'beta.event/v1',",
    '  payload: schema,',
    '};',
    'export const legacyEventTypes = {',
    "  finished: 'beta.map-a/v1',",
    "  started: 'beta.map-b/v1',",
    '} as const;',
    '',
  ].join('\n');
  const ids = [
    'beta.event/v1',
    'beta.hooks/v1',
    'beta.map-a/v1',
    'beta.map-b/v1',
    'beta.multi-line/v1',
    'beta.one-line/v1',
    'beta.string/v1',
  ];

  assert.deepEqual(
    findDeclared(
      snapshot({
        bundles: [
          bundle('beta', { provides: ids.map((id) => `${id}@1.0.0`) }),
          bundle('alpha'),
        ],
        files: [
          at('bundles/features/beta/src/contracts/index.ts', contracts),
          at(
            'bundles/features/alpha/src/use.ts',
            [
              'import {',
              '  EventsV1,',
              '  HooksV1,',
              '  legacyEventTypes,',
              '  MultiLineV1,',
              '  OneLineV1,',
              '  StringV1,',
              "} from 'beta/contracts';",
              '',
            ].join('\n'),
          ),
        ],
      }),
    ),
    ids.map((id) => finding('declared', 'alpha', id)),
  );
});

test('10. declared: import type { X } and { type X } are not uses; { X as Y } is', () => {
  assert.deepEqual(
    findDeclared(
      snapshot({
        bundles: [
          bundle('beta', {
            provides: ['beta.a/v1@1.0.0', 'beta.b/v1@1.0.0', 'beta.c/v1@1.0.0'],
          }),
          bundle('alpha'),
        ],
        files: [
          at(
            'bundles/features/beta/src/contracts/index.ts',
            [
              "export const AV1 = ref<A>('beta.a/v1');",
              "export const BV1 = ref<B>('beta.b/v1');",
              "export const CV1 = ref<C>('beta.c/v1');",
              '',
            ].join('\n'),
          ),
          at(
            'bundles/features/alpha/src/use.ts',
            [
              "import type { AV1 } from 'beta/contracts';",
              "import { type BV1, CV1 as Renamed } from 'beta/contracts';",
              '',
            ].join('\n'),
          ),
        ],
      }),
    ),
    [finding('declared', 'alpha', 'beta.c/v1')],
  );
});

test('11. declared: core using a bundle/contracts symbol is skipped; another bundle doing the same is found', () => {
  const use = "import { ModelsProviderV1 } from 'bundle/contracts';\n";

  assert.deepEqual(
    findDeclared(
      snapshot({
        packages: ['bundle', 'core', 'alpha', 'beta'],
        packageDirectories: { 'packages/bundle': 'bundle' },
        bundles: [
          bundle('core', { group: 'foundation' }),
          bundle('alpha'),
          bundle('beta', { provides: ['models.provider/v1@1.0.0'] }),
        ],
        files: [
          at(
            'packages/bundle/src/contracts/index.ts',
            "export const ModelsProviderV1 = ref<ModelsProvider>('models.provider/v1');\n",
          ),
          at('bundles/foundation/core/src/host/models.ts', use),
          at('bundles/features/alpha/src/models.ts', use),
        ],
      }),
    ),
    [finding('declared', 'alpha', 'models.provider/v1')],
  );
});

test('12. declared: a manifest line whose id no manifest provides is found; a doric. line is not', () => {
  assert.deepEqual(
    findDeclared(
      snapshot({
        bundles: [
          bundle('alpha', {
            requires: ['ghost.thing/v1@^1.0.0'],
            optional: ['doric.platform/v1@^1.0.0'],
          }),
        ],
      }),
    ),
    [finding('declared', 'alpha', 'ghost.thing/v1')],
  );
});

// T0.1, cycles

const cyclesOf = (bundles, listed = []) =>
  findCycles(snapshot({ bundles }), listed);

test('13. cycles: an acyclic graph with no entries is clean', () => {
  assert.deepEqual(
    cyclesOf([
      bundle('alpha', { requires: ['beta.x/v1@^1.0.0'] }),
      bundle('beta', {
        provides: ['beta.x/v1@1.0.0'],
        optional: ['gamma.x/v1@^1.0.0'],
      }),
      bundle('gamma', { provides: ['gamma.x/v1@1.0.0'] }),
    ]),
    clean,
  );
});

test('14. cycles: an unbroken cycle fails and names its bundles', () => {
  assert.deepEqual(
    cyclesOf([
      bundle('alpha', {
        provides: ['alpha.x/v1@1.0.0'],
        requires: ['beta.x/v1@^1.0.0'],
      }),
      bundle('beta', {
        provides: ['beta.x/v1@1.0.0'],
        optional: ['gamma.x/v1@^1.0.0'],
      }),
      bundle('gamma', {
        provides: ['gamma.x/v1@1.0.0'],
        requires: ['alpha.x/v1@^1.0.0'],
      }),
      bundle('delta', { requires: ['alpha.x/v1@^1.0.0'] }),
    ]),
    { components: [['alpha', 'beta', 'gamma']], unknown: [], unneeded: [] },
  );
});

test('15. cycles: a listed edge that is not in the graph fails', () => {
  const notAnEdge = entry('cycles', 'beta', 'alpha');

  assert.deepEqual(
    cyclesOf(
      [
        bundle('alpha', { requires: ['beta.x/v1@^1.0.0'] }),
        bundle('beta', { provides: ['beta.x/v1@1.0.0'] }),
      ],
      [notAnEdge],
    ),
    { components: [], unknown: [notAnEdge], unneeded: [] },
  );
});

test('16. cycles: a listed edge that breaks no cycle fails', () => {
  const needed = entry('cycles', 'beta', 'alpha');
  const unneeded = entry('cycles', 'gamma', 'alpha');

  assert.deepEqual(
    cyclesOf(
      [
        bundle('alpha', {
          provides: ['alpha.x/v1@1.0.0'],
          requires: ['beta.x/v1@^1.0.0'],
        }),
        bundle('beta', {
          provides: ['beta.x/v1@1.0.0'],
          requires: ['alpha.x/v1@^1.0.0'],
        }),
        bundle('gamma', { optional: ['alpha.x/v1@^1.0.0'] }),
      ],
      [needed, unneeded],
    ),
    { components: [], unknown: [], unneeded: [unneeded] },
  );
});

test('17. cycles: a sandbox/v1 edge runs from the provider to the declarer', () => {
  const declarer = snapshot({
    bundles: [
      bundle('runtime', {
        group: 'runtime',
        provides: ['runtime/v1@1.0.0'],
        requires: ['docker.extra/v1@^1.0.0'],
        optional: ['sandbox/v1@^1.0.0'],
      }),
      bundle('docker', {
        group: 'sandboxes',
        provides: ['sandbox/v1@1.0.0', 'docker.extra/v1@1.0.0'],
      }),
    ],
  });

  assert.deepEqual(findCycles(declarer, []), {
    components: [['docker', 'runtime']],
    unknown: [],
    unneeded: [],
  });
  assert.deepEqual(
    findCycles(declarer, [entry('cycles', 'docker', 'runtime')]),
    clean,
  );

  const other = snapshot({
    bundles: [
      bundle('transport', {
        group: 'foundation',
        provides: ['transport/v1@1.0.0'],
        requires: ['sandbox/v1@^1.0.0'],
      }),
      bundle('docker', {
        group: 'sandboxes',
        provides: ['sandbox/v1@1.0.0'],
        requires: ['transport/v1@^1.0.0'],
      }),
    ],
  });

  assert.deepEqual(findCycles(other, []), {
    components: [['docker', 'transport']],
    unknown: [],
    unneeded: [],
  });
});

test("17a. cycles: core's lines for models.provider/v1, storage.backend/v1 and secrets.backend/v1 run from their providers to core", () => {
  assert.deepEqual(
    cyclesOf([
      bundle('core', {
        group: 'foundation',
        provides: ['log/v1@1.1.0', 'secrets/v1@1.3.0'],
        requires: ['storage.backend/v1@^1.0.0', 'secrets.backend/v1@^1.0.0'],
        optional: ['models.provider/v1'],
      }),
      bundle('claude', {
        group: 'providers',
        provides: ['models.provider/v1@1.4.0'],
        requires: ['log/v1@^1.1.0'],
        optional: ['secrets/v1'],
      }),
      bundle('postgres', {
        group: 'storage',
        provides: ['storage.backend/v1@1.0.0', 'secrets.backend/v1@1.0.0'],
        optional: ['log/v1', 'secrets/v1'],
      }),
    ]),
    clean,
  );
});

// T0.1, core

test('18. core: a desktopScope entry with projectId is found as <contract>:projectId; other keys are not', () => {
  assert.deepEqual(
    findCore(
      snapshot({
        bundles: [
          bundle('core', {
            group: 'foundation',
            desktopScope: {
              'windows/v1': ['projectId', 'kind'],
              'menus/v1': ['region'],
            },
          }),
        ],
      }),
    ),
    [finding('core', 'core', 'windows/v1:projectId')],
  );
});

test("19. core: a platform src import of a bundle's package is found with the package name as bundle; a platform package import is not", () => {
  const imports = [
    "import { RuntimeV1 } from 'runtime/contracts';",
    "import { session } from 'session';",
    '',
  ].join('\n');

  assert.deepEqual(
    findCore(
      snapshot({
        packages: ['doric-host', 'session', 'runtime'],
        packageDirectories: {
          'app/backend/doric-host': 'doric-host',
          'packages/session': 'session',
        },
        bundles: [bundle('runtime', { group: 'runtime' })],
        files: [
          at('app/backend/doric-host/src/index.ts', imports),
          at('packages/session/src/__tests__/a.ts', imports),
          at('packages/session/src/a.test.ts', imports),
        ],
      }),
    ),
    [finding('core', 'doric-host', 'runtime/contracts')],
  );
});

test("20. core: '/settings' in a core source file is found with the file as target", () => {
  const source = "navigate('/settings');\n";

  assert.deepEqual(
    findCore(
      snapshot({
        bundles: [bundle('core', { group: 'foundation' }), bundle('alpha')],
        files: [
          at('bundles/foundation/core/src/desktop/commands.ts', source),
          at('bundles/features/alpha/src/settings.ts', source),
        ],
      }),
    ),
    [
      finding(
        'core',
        'core',
        'bundles/foundation/core/src/desktop/commands.ts',
      ),
    ],
  );
});

// T0.1, lists

test('21. lists: no line on the spec\'s "left alone" list gives a finding', () => {
  const leftAlone = [
    'COPY bundles ./bundles',
    '# The host stages each bundle under dist/bundles/core.',
    'RUN cp -r app/backend/doric-host/dist/bundles /out',
    'RUN ls bundles/*/*/manifest.json',
    'RUN node stage --all bundles',
    '"tags": ["tag:type:bundle"],',
    '"dependsOn": ["build-bundles"]',
    '',
  ].join('\n');

  assert.deepEqual(
    findLists(
      snapshot({
        buildFiles: [
          at('app/backend/doric-host/project.json', leftAlone),
          at('app/backend/doric-host/.Dockerfile', leftAlone),
        ],
      }),
    ),
    [],
  );
});

test('22. lists: a written-out path and a "bundle-x" name are each found, one finding per file', () => {
  assert.deepEqual(
    findLists(
      snapshot({
        buildFiles: [
          at(
            'app/backend/doric-host/project.json',
            '"dependsOn": ["bundle-core"]\n',
          ),
          at(
            'app/backend/doric-host/.Dockerfile',
            [
              'COPY bundles/foundation/core/dist ./core',
              'COPY bundles/features/git/dist ./git',
              '',
            ].join('\n'),
          ),
        ],
      }),
    ),
    [
      finding('lists', 'doric-host', 'app/backend/doric-host/.Dockerfile'),
      finding('lists', 'doric-host', 'app/backend/doric-host/project.json'),
    ],
  );
});

test('23. lists: a composition id with no manifest is found', () => {
  assert.deepEqual(
    findLists(
      snapshot({
        bundles: [
          bundle('core', { group: 'foundation' }),
          bundle('docker', { group: 'sandboxes' }),
        ],
        composition: {
          core: 'core',
          enabled: ['core', 'ghost'],
          providers: { 'storage.backend/v1': 'phantom' },
          alternatives: {
            sandbox: { default: 'docker', options: ['docker', 'firecracker'] },
          },
        },
      }),
    ),
    [
      finding('lists', 'doric-host', 'firecracker'),
      finding('lists', 'doric-host', 'ghost'),
      finding('lists', 'doric-host', 'phantom'),
    ],
  );
});

// T0.1, dependencies

test('24. dependencies: each of the five ways a package counts as used gives no finding', () => {
  assert.deepEqual(
    findDependencies(
      snapshot({
        bundles: [
          bundle('alpha', {
            packageJson: {
              dependencies: {
                '@scope/lib': '1.0.0',
                react: '^19.0.0',
                tslib: '^2.3.0',
                zod: '^4.4.3',
              },
              devDependencies: {
                '@types/node': '^22.0.0',
                '@types/scope__lib': '1.0.0',
                beta: '0.0.1',
              },
            },
          }),
          bundle('postgres', {
            group: 'foundation',
            packageJson: { dependencies: { '@prisma/client': '^6.0.0' } },
          }),
        ],
        files: [
          at(
            'bundles/features/alpha/src/a.ts',
            [
              "import { z } from 'zod';",
              "import { lib } from '@scope/lib/sub';",
              '',
            ].join('\n'),
          ),
          at(
            'bundles/features/alpha/src/view.tsx',
            'export const View = () => null;\n',
          ),
          at(
            'bundles/features/alpha/tests/window.ts',
            "const path = import.meta.resolve('beta/package.json');\n",
          ),
        ],
      }),
    ),
    [],
  );
});

test('25. dependencies: an unused dependencies line, an unused devDependencies line and react without a .tsx file are found', () => {
  assert.deepEqual(
    findDependencies(
      snapshot({
        bundles: [
          bundle('alpha', {
            packageJson: {
              dependencies: { both: '1.0.0', 'left-pad': '1.0.0' },
              devDependencies: { both: '1.0.0', 'right-pad': '1.0.0' },
            },
          }),
          bundle('beta', {
            packageJson: { dependencies: { react: '^19.0.0' } },
          }),
        ],
        files: [
          at('bundles/features/alpha/src/a.ts', 'export const a = 1;\n'),
          at('bundles/features/beta/src/b.ts', 'export const b = 1;\n'),
        ],
      }),
    ),
    [
      finding('dependencies', 'alpha', 'both'),
      finding('dependencies', 'alpha', 'left-pad'),
      finding('dependencies', 'alpha', 'right-pad'),
      finding('dependencies', 'beta', 'react'),
    ],
  );
});

test('25a. dependencies: @bufbuild/protobuf counts as used only when exports has ./contracts/gen/*', () => {
  const protobuf = { dependencies: { '@bufbuild/protobuf': '^2.17.0' } };

  assert.deepEqual(
    findDependencies(
      snapshot({
        bundles: [
          bundle('alpha', {
            packageJson: {
              ...protobuf,
              exports: {
                './contracts/gen/*': {
                  '@org/source': './src/contracts/gen/*',
                },
              },
            },
          }),
          bundle('beta', { packageJson: protobuf }),
        ],
        files: [
          at('bundles/features/alpha/src/a.ts', 'export const a = 1;\n'),
          at('bundles/features/beta/src/b.ts', 'export const b = 1;\n'),
        ],
      }),
    ),
    [finding('dependencies', 'beta', '@bufbuild/protobuf')],
  );
});

// T0.1 and T0.2, comparison

test('26. diffViolations reports an unlisted finding, a stale entry and an entry whose decision file does not exist', () => {
  const unlisted = finding('declared', 'alpha', 'beta.thing/v1');
  const matched = finding('core', 'core', 'windows/v1:projectId');
  const matching = entry('core', 'core', 'windows/v1:projectId', 'docs/ok.md');
  const stale = entry('lists', 'doric-host', 'gone.json', 'docs/ok.md');
  const undocumented = entry('cycles', 'alpha', 'beta', 'docs/missing.md');

  assert.deepEqual(
    diffViolations({
      findings: [unlisted, matched],
      entries: [matching, stale, undocumented],
      exists: (path) => path === 'docs/ok.md',
    }),
    { unlisted: [unlisted], stale: [stale], undocumented: [undocumented] },
  );
});

// T0.2, the real repository

const fromRoot = (file) => relative(root, file).split(sep).join('/');

const readJson = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const childDirectories = (path) =>
  readdirSync(join(root, path), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${path}/${entry.name}`);

const realSnapshot = () => {
  const workspaces = [
    ...childDirectories('packages'),
    ...childDirectories('tools'),
    ...childDirectories('app').flatMap(childDirectories),
    ...childDirectories('bundles').flatMap(childDirectories),
  ];
  const packageDirectories = {};

  for (const directory of workspaces) {
    if (!existsSync(join(root, directory, 'package.json'))) continue;
    const { name } = readJson(`${directory}/package.json`);
    if (typeof name === 'string') packageDirectories[directory] = name;
  }

  const bundles = childDirectories('bundles')
    .flatMap(childDirectories)
    .filter((directory) => existsSync(join(root, directory, 'manifest.json')))
    .map((directory) => {
      const manifest = readJson(`${directory}/manifest.json`);
      return {
        id: manifest.id,
        directory,
        manifest,
        packageJson: readJson(`${directory}/package.json`),
      };
    });

  return {
    files: ['packages', 'app', 'tools', 'bundles']
      .flatMap((directory) => sourceFiles(join(root, directory)))
      .map((file) => at(fromRoot(file), readFileSync(file, 'utf8'))),
    packages: workspacePackageNames(),
    packageDirectories,
    bundles,
    buildFiles: [
      'app/backend/doric-host/project.json',
      'app/backend/doric-host/.Dockerfile',
    ].map((path) => at(path, readFileSync(join(root, path), 'utf8'))),
    composition: readJson('app/backend/doric-host/composition.json'),
  };
};

const isFile = (path) =>
  existsSync(join(root, path)) && statSync(join(root, path)).isFile();

test('27. the real repository: the findings of each of the six checks equal the violations entries', async (t) => {
  const { violations } = readJson('tests/boundary-exceptions.json');
  const repository = realSnapshot();
  const entriesOf = (check) =>
    violations.filter((item) => item.check === check);

  const manifestsOnDisk = readdirSync(join(root, 'bundles')).flatMap((group) =>
    statSync(join(root, 'bundles', group)).isDirectory()
      ? readdirSync(join(root, 'bundles', group)).filter((name) =>
          isFile(`bundles/${group}/${name}/manifest.json`),
        )
      : [],
  );
  assert.ok(manifestsOnDisk.length > 0);
  assert.equal(repository.bundles.length, manifestsOnDisk.length);

  for (const [check, find] of [
    ['imports', findImports],
    ['declared', findDeclared],
    ['core', findCore],
    ['lists', findLists],
    ['dependencies', findDependencies],
  ]) {
    await t.test(check, () => {
      assert.deepEqual(
        diffViolations({
          findings: find(repository),
          entries: entriesOf(check),
          exists: isFile,
        }),
        { unlisted: [], stale: [], undocumented: [] },
      );
    });
  }

  await t.test('cycles', () => {
    const listed = entriesOf('cycles');

    assert.deepEqual(findCycles(repository, listed), clean);
    assert.deepEqual(
      listed.filter(({ decision }) => !isFile(decision)),
      [],
    );
  });
});
