import assert from 'node:assert/strict';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { z } from 'zod';

import { readStaticServices } from '../src/build/cli.js';
import {
  defineHook,
  defineHooks,
  defineMethod,
  defineService,
  HooksV1,
  type HostContext,
} from '../src/contracts/index.js';
import {
  BuildError,
  buildBundle,
  checkRecording,
  contractDocument,
  manifestV1Schema,
  platformSchemaDocuments,
  recordActivation,
  runCli,
  stageBundles,
} from '../src/index.js';
import {
  contractsUrl,
  manifest,
  skillSource,
  withRoot,
  writeBundle,
} from './support/fixtures.js';

const zodUrl = import.meta.resolve('zod');

const demoManifest = (
  options: {
    version?: string;
    api?: string;
    requires?: readonly string[];
  } = {},
) =>
  manifest('demo', {
    version: options.version ?? '1.0.0',
    provides: [
      `demo.api/v1@${options.api ?? '1.0.0'}`,
      'demo.hooks/v1@1.0.0',
      'demo.desk/v1@1.0.0',
    ],
    requires: ['hooks/v1@^1.0.0', ...(options.requires ?? [])],
  });

const hostPart = (
  methods: string,
) => `import { z } from ${JSON.stringify(zodUrl)};
import { defineHook, defineHooks, defineMethod, defineService, HooksV1, LogV1 } from ${JSON.stringify(contractsUrl)};
const api = defineService('demo.api/v1', { ${methods} });
const hooks = defineHooks('demo.hooks/v1', {
  onThingHook: defineHook({ kind: 'observe', input: z.object({ id: z.string() }).strict() }),
});
export const activate = ({ services }) => {
  services.provide(api);
  services.use(HooksV1).define(hooks);
  if (globalThis.__demoUsesLog) services.use(LogV1).info('x');
};
`;

const getMethod = `get: defineMethod({ input: z.object({ id: z.string() }).strict(), output: z.object({ n: z.number() }).strict(), execute: () => ({ n: 1 }) })`;

const desktopPart = `import { z } from ${JSON.stringify(zodUrl)};
import { defineMethod, defineService } from ${JSON.stringify(contractsUrl)};
export const activate = ({ services }) => {
  services.provide(defineService('demo.desk/v1', {
    ping: defineMethod({ input: z.tuple([]), output: z.literal('pong'), execute: () => 'pong' }),
  }));
};
`;

const writeDemo = (
  root: string,
  options: {
    manifest?: unknown;
    host?: string;
    files?: Record<string, string>;
    directory?: string;
  } = {},
) =>
  writeBundle(root, options.directory ?? 'demo', {
    manifest: options.manifest ?? demoManifest(),
    files: {
      'dist/host/index.js': options.host ?? hostPart(getMethod),
      'dist/desktop/index.js': desktopPart,
      'src/skills/01-use/SKILL.md': skillSource('use-demo', {
        alwaysAvailable: true,
      }),
      ...options.files,
    },
  });

const exists = async (path: string) => {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
};

void test('the build records environments, writes the descriptor, schemas and skills', async () => {
  await withRoot(async (root) => {
    const dir = await writeDemo(root, {
      files: { 'dist/skills/stale/SKILL.md': skillSource('stale') },
    });
    const { descriptor } = await buildBundle(dir);

    assert.deepEqual(
      descriptor.contracts.map(({ id, kind, environment, cardinality }) => [
        id,
        kind,
        environment,
        cardinality,
      ]),
      [
        ['demo.api/v1', 'service', 'host', 'one'],
        ['demo.hooks/v1', 'hooks', 'host', 'one'],
        ['demo.desk/v1', 'service', 'desktopMain', 'one'],
      ],
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, 'dist', 'contracts.json'), 'utf8')),
      descriptor,
    );

    const schema = JSON.parse(
      await readFile(
        join(dir, 'dist', 'schemas', 'demo.api', 'v1.json'),
        'utf8',
      ),
    ) as { $id: string; $defs: Record<string, unknown> };

    assert.equal(schema.$id, 'doric:contract/demo.api/v1');
    assert.deepEqual(Object.keys(schema.$defs).sort(), [
      'get.input',
      'get.output',
    ]);
    assert.equal(
      await exists(join(dir, 'dist', 'skills', '01-use', 'SKILL.md')),
      true,
    );
    assert.equal(await exists(join(dir, 'dist', 'skills', 'stale')), false);
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, 'dist', 'package.json'), 'utf8')),
      { type: 'module' },
    );
    assert.equal(
      manifestV1Schema.parse(
        JSON.parse(await readFile(join(dir, 'dist', 'manifest.json'), 'utf8')),
      ).id,
      'demo',
    );
  });
});

void test('the build fails on an undeclared use, an unrecorded provide or an invalid skill', async () => {
  await withRoot(async (root) => {
    const dir = await writeDemo(root);

    (globalThis as { __demoUsesLog?: boolean }).__demoUsesLog = true;

    try {
      await assert.rejects(buildBundle(dir), /log\/v1/);
    } finally {
      delete (globalThis as { __demoUsesLog?: boolean }).__demoUsesLog;
    }
  });

  await withRoot(async (root) => {
    const dir = await writeDemo(root, {
      manifest: manifest('demo', {
        provides: [
          'demo.api/v1@1.0.0',
          'demo.hooks/v1@1.0.0',
          'demo.desk/v1@1.0.0',
          'demo.ghost/v1@1.0.0',
        ],
        requires: ['hooks/v1@^1.0.0'],
      }),
    });

    await assert.rejects(buildBundle(dir), /demo\.ghost\/v1/);
  });

  await withRoot(async (root) => {
    const dir = await writeDemo(root, {
      files: { 'src/skills/02-bad/SKILL.md': 'no frontmatter' },
    });

    await assert.rejects(buildBundle(dir), /Invalid skill/);
  });
});

void test('the build ignores a leftover contracts.published.json and writes none', async () => {
  await withRoot(async (root) => {
    // A baseline claiming a newer bundle version with no contracts: the old
    // semver check refused the build here; without the check it passes.
    const leftover = JSON.stringify({
      descriptorVersion: 1,
      bundle: { id: 'demo', version: '9.0.0' },
      contracts: [],
    });
    const dir = await writeDemo(root, {
      files: { 'contracts.published.json': leftover },
    });

    const { descriptor } = await buildBundle(dir);

    assert.deepEqual(
      descriptor.contracts.map(({ id }) => id),
      ['demo.api/v1', 'demo.hooks/v1', 'demo.desk/v1'],
    );
    assert.equal(
      await readFile(join(dir, 'contracts.published.json'), 'utf8'),
      leftover,
    );
  });

  await withRoot(async (root) => {
    const dir = await writeDemo(root);

    await buildBundle(dir);

    assert.equal(await exists(join(dir, 'contracts.published.json')), false);
  });
});

void test('the CLI has no baseline command; build and stage remain', async () => {
  await withRoot(async (root) => {
    const dir = await writeDemo(root);

    await assert.rejects(runCli(['baseline', dir]), /Usage: cli\.js build/);
    assert.equal(await exists(join(dir, 'contracts.published.json')), false);
  });
});

void test('the build copies host Markdown into dist before the dry activation, replacing stale copies', async () => {
  await withRoot(async (root) => {
    const dir = await writeDemo(root, {
      host: `import { readFileSync } from 'node:fs';
readFileSync(new URL('./prompts/a.md', import.meta.url));
${hostPart(getMethod)}`,
      files: {
        'src/host/prompts/a.md': 'A\n',
        'src/host/b.md': 'B\n',
        'dist/host/old.md': 'stale\n',
      },
    });

    await buildBundle(dir);

    assert.equal(
      await readFile(join(dir, 'dist', 'host', 'prompts', 'a.md'), 'utf8'),
      'A\n',
    );
    assert.equal(await exists(join(dir, 'dist', 'host', 'b.md')), true);
    assert.equal(await exists(join(dir, 'dist', 'host', 'old.md')), false);
    assert.equal(await exists(join(dir, 'dist', 'host', 'index.js')), true);
  });
});

void test('copy-md mirrors the Markdown of a tree and keeps other files', async () => {
  await withRoot(async (root) => {
    const from = join(root, 'from');
    const to = join(root, 'to');

    await mkdir(join(from, 'nested', 'deeper'), { recursive: true });
    await writeFile(join(from, 'nested', 'deeper', 'note.md'), 'note\n');
    await mkdir(join(to, 'old'), { recursive: true });
    await writeFile(join(to, 'old', 'stale.md'), 'stale\n');
    await writeFile(join(to, 'index.js'), 'export {};\n');

    await runCli(['copy-md', from, to]);

    assert.equal(
      await readFile(join(to, 'nested', 'deeper', 'note.md'), 'utf8'),
      'note\n',
    );
    assert.equal(await exists(join(to, 'old', 'stale.md')), false);
    assert.equal(await readFile(join(to, 'index.js'), 'utf8'), 'export {};\n');
  });
});

void test('the recorder sees provides, hook definitions and only declared uses', async () => {
  const source = manifestV1Schema.parse(
    manifest('rec', {
      provides: ['rec.api/v1@1.0.0', 'rec.hooks/v1@1.0.0', 'hooks/v1@1.0.0'],
      requires: ['hooks/v1@^1.0.0'],
    }),
  );
  const RecHooksV1 = defineHooks('rec.hooks/v1', {
    onX: defineHook({ kind: 'decide', input: z.object({}).strict() }),
  });
  const recorded = await recordActivation({
    manifest: source,
    environment: 'host',
    activate: ({ services }: HostContext) => {
      services.provide(
        defineService('rec.api/v1', {
          fn: defineMethod({
            input: z.custom<() => void>(),
            output: z.void(),
            execute: () => undefined,
          }),
        }),
      );
      services.use(HooksV1).define(RecHooksV1);
      services.whenAvailable(HooksV1, () => {
        throw new Error('never fires');
      });
    },
  });

  assert.deepEqual(
    recorded.map(({ id, kind }) => `${id}:${kind}`),
    ['rec.api/v1:service', 'rec.hooks/v1:hooks'],
  );
  const problems = checkRecording(source, recorded);

  assert.equal(problems.length, 1);
  assert.match(problems[0] ?? '', /hooks\/v1/);
  assert.equal(
    contractDocument(recorded[0] as (typeof recorded)[number]).local,
    true,
  );
  assert.equal(
    contractDocument(recorded[1] as (typeof recorded)[number]).local,
    false,
  );
});

void test('several records of a many contract from one bundle are one recorded contract', async () => {
  const source = manifestV1Schema.parse(
    manifest('rec', {
      provides: ['rec.kinds/v1@1.0.0', 'rec.single/v1@1.0.0'],
    }),
  );
  const method = defineMethod({
    input: z.tuple([]),
    output: z.string(),
    execute: () => 'kind',
  });
  const recorded = await recordActivation({
    manifest: source,
    environment: 'host',
    activate: ({ services }: HostContext) => {
      for (let index = 0; index < 3; index += 1) {
        services.provide(
          defineService(
            'rec.kinds/v1',
            { kind: method },
            { cardinality: 'many' },
          ),
        );
      }

      services.provide(defineService('rec.single/v1', { kind: method }));
      services.provide(defineService('rec.single/v1', { kind: method }));
    },
  });

  assert.deepEqual(
    recorded.map(({ id, cardinality }) => `${id}:${cardinality}`),
    ['rec.kinds/v1:many', 'rec.single/v1:one', 'rec.single/v1:one'],
  );
  assert.deepEqual(checkRecording(source, recorded), [
    'rec.single/v1 is recorded more than once in host.',
  ]);
});

void test('the recorder refuses hooks.use of a hooks contract outside requires', async () => {
  const OtherHooksV1 = defineHooks('other.hooks/v1', {
    onY: defineHook({ kind: 'observe', input: z.object({}).strict() }),
  });
  const record = (requires: readonly string[]) =>
    recordActivation({
      manifest: manifestV1Schema.parse(manifest('rec', { requires })),
      environment: 'host',
      activate: ({ services }: HostContext) => {
        services.use(HooksV1).use(OtherHooksV1);
      },
    });

  await assert.rejects(record(['hooks/v1@^1.0.0']), {
    name: 'RecordingError',
    message: /other\.hooks\/v1/,
  });
  assert.deepEqual(
    await record(['hooks/v1@^1.0.0', 'other.hooks/v1@^1.0.0']),
    [],
  );
});

void test('staging replaces each bundle directory with its dist', async () => {
  await withRoot(async (root) => {
    const dir = await writeDemo(root);
    const destination = join(root, 'staged');

    await buildBundle(dir);
    await writeBundle(destination, 'demo', {
      manifest: {},
      files: { 'leftover.txt': 'x' },
    });
    await stageBundles(destination, [dir]);

    assert.equal(
      await exists(join(destination, 'demo', 'contracts.json')),
      true,
    );
    assert.equal(
      await exists(join(destination, 'demo', 'host', 'index.js')),
      true,
    );
    assert.equal(
      await exists(join(destination, 'demo', 'leftover.txt')),
      false,
    );
  });
});

const writeBuiltDemo = async (root: string, directory: string, id: string) => {
  const dir = await writeDemo(root, {
    directory,
    manifest: { ...demoManifest(), id },
  });

  await buildBundle(dir);

  return dir;
};

void test('stage --all stages every <group>/<id> with a manifest and skips the rest', async () => {
  await withRoot(async (root) => {
    const bundles = join(root, 'bundles');
    const destination = join(root, 'staged');

    await writeBuiltDemo(bundles, join('g1', 'a'), 'a');
    await writeBuiltDemo(bundles, join('g1', 'b'), 'b');
    await writeBuiltDemo(bundles, join('g2', 'c'), 'c');
    await mkdir(join(bundles, 'g1', 'node_modules', 'dep'), {
      recursive: true,
    });
    await writeFile(join(bundles, 'g1', 'node_modules', 'dep', 'index.js'), '');
    await writeFile(join(bundles, 'g2', 'x.txt'), 'x\n');

    await runCli(['stage', destination, '--all', bundles]);

    const staged = await readdir(destination, { withFileTypes: true });

    assert.deepEqual(
      staged
        .map((entry) => [entry.name, entry.isDirectory()] as const)
        .sort(([left], [right]) => (left < right ? -1 : 1)),
      [
        ['a', true],
        ['b', true],
        ['c', true],
      ],
    );
    assert.equal(
      await exists(join(destination, 'c', 'host', 'index.js')),
      true,
    );
  });
});

void test('stage --all names a bundle directory whose dist manifest is missing', async () => {
  await withRoot(async (root) => {
    const bundles = join(root, 'bundles');

    await writeBuiltDemo(bundles, join('g1', 'a'), 'a');
    await writeBundle(join(bundles, 'g1'), 'z', {
      manifest: { ...demoManifest(), id: 'z' },
    });

    await assert.rejects(
      runCli(['stage', join(root, 'staged'), '--all', bundles]),
      (error: unknown) => {
        assert.ok(error instanceof BuildError);
        assert.match(error.message, /g1\/z/);

        return true;
      },
    );
  });
});

void test('stage --all takes exactly a destination and a root', async () => {
  await withRoot(async (root) => {
    const destination = join(root, 'staged');

    await assert.rejects(
      runCli(['stage', destination, '--all']),
      /Usage: cli\.js/,
    );
    await assert.rejects(
      runCli(['stage', destination, '--all', root, 'extra']),
      /Usage: cli\.js/,
    );
  });
});

void test('platform schema documents cover the manifest, composition, descriptor and contracts', () => {
  const documents = platformSchemaDocuments();

  assert.equal(
    documents.get('bundle-manifest/v1.json')?.$id,
    'doric://app/schemas/bundle-manifest/v1.json',
  );

  for (const path of [
    'composition/v1.json',
    'contracts-descriptor/v1.json',
    'contracts/hooks/v1.json',
    'contracts/tools/v1.json',
    'contracts/doric.catalog/v1.json',
    'contracts/doric.app.hooks/v1.json',
  ]) {
    assert.ok(documents.has(path), path);
  }
});

void test('platform schema documents publish the v2 bundle manifest', () => {
  const document = platformSchemaDocuments().get('bundle-manifest/v2.json');

  assert.equal(document?.$id, 'doric://app/schemas/bundle-manifest/v2.json');
});

// The environment rule's build check (spec `docs/designs/grpc-processes.md`,
// "The environment rule", A62, A63; T2.15).

const providing = (id: string) => `import { z } from ${JSON.stringify(zodUrl)};
import { defineMethod, defineService } from ${JSON.stringify(contractsUrl)};
export const activate = ({ services }) => {
  services.provide(defineService(${JSON.stringify(id)}, {
    ping: defineMethod({ input: z.tuple([]), output: z.literal('pong'), execute: () => 'pong' }),
  }));
};
`;

const environmentManifest = (
  manifestVersion: 1 | 2,
  provides: readonly string[],
) => ({
  manifestVersion,
  id: 'demo',
  version: '1.0.0',
  engines: { doric: '^1.0.0' },
  provides: [...provides],
});

/** A host `main.ts` whose `runBundle` lists `entries` (source of each pair). */
const mainWith = (imports: string, entries: readonly string[]) => `${imports}
import { runBundle } from 'bundle';

runBundle({
  services: [
${entries.map((entry) => `    ${entry},`).join('\n')}
  ],
  activate: () => undefined,
});
`;

const rejectsWithCode = async (
  run: Promise<unknown>,
  code: string,
  named: readonly string[],
) =>
  assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof BuildError, String(error));
    assert.equal(error.code, code, error.message);

    for (const text of named) {
      assert.ok(error.message.includes(text), error.message);
    }

    return true;
  });

void test('a v2 host part that provides a CLIENT contract fails with contract_environment', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(2, ['ui/v1@1.0.0']),
      files: { 'dist/host/index.js': providing('ui/v1') },
    });

    await rejectsWithCode(buildBundle(dir), 'contract_environment', [
      'ui/v1',
      'host',
    ]);
  });
});

void test('a v1 host part that provides a CLIENT contract still builds', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(1, ['ui/v1@1.0.0']),
      files: { 'dist/host/index.js': providing('ui/v1') },
    });
    const { descriptor } = await buildBundle(dir);

    assert.deepEqual(
      descriptor.contracts.map(({ id, environment }) => [id, environment]),
      [['ui/v1', 'host']],
    );
  });
});

void test('a v2 desktopMain part that provides a contract of the index fails with contract_environment', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(2, ['tools/v1@1.0.0']),
      files: { 'dist/desktop/index.js': providing('tools/v1') },
    });

    await rejectsWithCode(buildBundle(dir), 'contract_environment', [
      'tools/v1',
      'desktopMain',
    ]);
  });
});

void test('a v2 host part builds with its HOST contract and a HOST handler service', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(2, ['tools/v1@1.0.0']),
      files: {
        'dist/host/index.js': providing('tools/v1'),
        'src/host/main.ts': mainWith(
          "import { ToolHandlerService } from '../contracts/gen/doric/tools/v1/tools_pb.js';",
          ['[ToolHandlerService, {}]'],
        ),
        // Stand-ins so esbuild resolves main.ts's imports; the build checks
        // the services list against the package's own generated tools.proto.
        'src/contracts/gen/doric/tools/v1/tools_pb.ts':
          'export const ToolHandlerService = {};\n',
        'node_modules/bundle/package.json': JSON.stringify({
          name: 'bundle',
          type: 'module',
          exports: { '.': './index.js' },
        }),
        'node_modules/bundle/index.js':
          'export const runBundle = () => undefined;\n',
      },
    });
    const { descriptor } = await buildBundle(dir);

    assert.deepEqual(
      descriptor.contracts.map(({ id, environment }) => [id, environment]),
      [['tools/v1', 'host']],
    );
    await access(join(dir, 'dist', 'host', 'main.mjs'));
  });
});

for (const [contract, service, module] of [
  ['commands/v1', 'CommandHandlerService', 'doric/commands/v1/commands_pb.js'],
  ['ui/v1', 'UiService', 'doric/ui/v1/ui_pb.js'],
] as const) {
  void test(`a v2 host services list naming ${service} of the CLIENT contract ${contract} fails with contract_environment`, async () => {
    await withRoot(async (root) => {
      const dir = await writeBundle(root, 'demo', {
        manifest: environmentManifest(2, ['demo.api/v1@1.0.0']),
        files: {
          'dist/host/index.js': providing('demo.api/v1'),
          'src/host/main.ts': mainWith(
            `import { ${service} } from '../contracts/gen/${module}';`,
            [`[${service}, {}]`],
          ),
        },
      });

      await rejectsWithCode(buildBundle(dir), 'contract_environment', [
        contract,
        service,
        'host',
      ]);
    });
  });
}

void test('a v2 host services list that is not static fails with services_not_static', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(2, ['demo.api/v1@1.0.0']),
      files: {
        'dist/host/index.js': providing('demo.api/v1'),
        'src/host/main.ts': `import { runBundle } from 'bundle';
import { ToolHandlerService } from '../contracts/gen/doric/tools/v1/tools_pb.js';

const list = [[ToolHandlerService, {}]];

runBundle({ services: list, activate: () => undefined });
`,
      },
    });

    await rejectsWithCode(buildBundle(dir), 'services_not_static', [
      'src/host/main.ts:6',
    ]);
  });
});

void test('a v2 host services entry naming no service of the index fails with services_not_static', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(2, ['demo.api/v1@1.0.0']),
      files: {
        'dist/host/index.js': providing('demo.api/v1'),
        'src/host/main.ts': mainWith(
          "import { MissingService } from '../contracts/gen/doric/tools/v1/tools_pb.js';",
          ['[MissingService, {}]'],
        ),
      },
    });

    await rejectsWithCode(buildBundle(dir), 'services_not_static', [
      'src/host/main.ts:6',
    ]);
  });
});

void test('readStaticServices reads the entries of a static services list in order', async () => {
  await withRoot(async (root) => {
    const dir = await writeBundle(root, 'demo', {
      manifest: environmentManifest(2, []),
      files: {
        'src/host/main.ts': `import { runBundle } from 'bundle';
import { ToolHandlerService } from 'bundle/contracts/gen/doric/tools/v1/tools_pb.js';
import { DemoService } from '../contracts/gen/demo/v1/demo_pb.js';

runBundle({
  services: [
    [ToolHandlerService, { check: () => ({}), execute: () => ({}) }],
    [DemoService, {}],
  ],
  activate: () => undefined,
});
`,
      },
    });

    assert.deepEqual(await readStaticServices(dir), [
      {
        protoFile: 'doric/tools/v1/tools.proto',
        service: 'ToolHandlerService',
        module: 'bundle/contracts/gen/doric/tools/v1/tools_pb.js',
        location: 'src/host/main.ts:7',
      },
      {
        protoFile: 'demo/v1/demo.proto',
        service: 'DemoService',
        module: '../contracts/gen/demo/v1/demo_pb.js',
        location: 'src/host/main.ts:8',
      },
    ]);
  });
});

void test('readStaticServices answers [] without main.ts, without runBundle or without services', async () => {
  await withRoot(async (root) => {
    const missing = await writeBundle(root, 'missing', {
      manifest: environmentManifest(2, []),
    });
    const noCall = await writeBundle(root, 'no-call', {
      manifest: environmentManifest(2, []),
      files: { 'src/host/main.ts': 'export const value = 1;\n' },
    });
    const noServices = await writeBundle(root, 'no-services', {
      manifest: environmentManifest(2, []),
      files: {
        'src/host/main.ts': `import { runBundle } from 'bundle';

runBundle({ activate: () => undefined });
`,
      },
    });

    assert.deepEqual(await readStaticServices(missing), []);
    assert.deepEqual(await readStaticServices(noCall), []);
    assert.deepEqual(await readStaticServices(noServices), []);
  });
});

const generated = "'../contracts/gen/demo/v1/demo_pb.js'";

for (const [form, source] of [
  [
    'an identifier',
    `import { runBundle } from 'bundle';
import { DemoService } from ${generated};
const list = [[DemoService, {}]];
runBundle({ services: list, activate: () => undefined });
`,
  ],
  [
    'a shorthand property',
    `import { runBundle } from 'bundle';
import { DemoService } from ${generated};
const services = [[DemoService, {}]];
runBundle({ services, activate: () => undefined });
`,
  ],
  [
    'a conditional',
    `import { runBundle } from 'bundle';
import { DemoService } from ${generated};
runBundle({ services: globalThis.flag ? [] : [[DemoService, {}]], activate: () => undefined });
`,
  ],
  [
    'a spread element',
    `import { runBundle } from 'bundle';
import { DemoService } from ${generated};
const extra = [[DemoService, {}]];
runBundle({ services: [...extra], activate: () => undefined });
`,
  ],
  [
    'an entry that is not an array literal',
    `import { runBundle } from 'bundle';
import { DemoService } from ${generated};
const entry = [DemoService, {}];
runBundle({ services: [entry], activate: () => undefined });
`,
  ],
  [
    'a service of a namespace import',
    `import { runBundle } from 'bundle';
import * as demo from ${generated};
runBundle({ services: [[demo.DemoService, {}]], activate: () => undefined });
`,
  ],
  [
    'a service of a default import',
    `import { runBundle } from 'bundle';
import DemoService from ${generated};
runBundle({ services: [[DemoService, {}]], activate: () => undefined });
`,
  ],
  [
    'a service of a module that is not generated',
    `import { runBundle } from 'bundle';
import { DemoService } from './services.js';
runBundle({ services: [[DemoService, {}]], activate: () => undefined });
`,
  ],
  [
    'a service that is not imported',
    `import { runBundle } from 'bundle';
const DemoService = {};
runBundle({ services: [[DemoService, {}]], activate: () => undefined });
`,
  ],
  [
    'two calls of runBundle',
    `import { runBundle } from 'bundle';
import { DemoService } from ${generated};
runBundle({ services: [[DemoService, {}]], activate: () => undefined });
runBundle({ services: [[DemoService, {}]], activate: () => undefined });
`,
  ],
] as const) {
  void test(`readStaticServices refuses ${form} with services_not_static`, async () => {
    await withRoot(async (root) => {
      const dir = await writeBundle(root, 'demo', {
        manifest: environmentManifest(2, []),
        files: { 'src/host/main.ts': source },
      });

      await assert.rejects(readStaticServices(dir), (error: unknown) => {
        assert.ok(error instanceof BuildError, String(error));
        assert.equal(error.code, 'services_not_static');
        assert.match(error.message, /^src\/host\/main\.ts:\d+: \S/);

        return true;
      });
    });
  });
}
