// The catalog index (spec `docs/designs/grpc-processes.md`, section 8, G5)
// over the generated files of this package and over small fixture files, and
// the environment clause of AC2.4 (T2.15) checked on the descriptors of the
// repository image.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { describe } from 'node:test';

import {
  create,
  createFileRegistry,
  type DescFile,
  fromBinary,
  getExtension,
  hasExtension,
  type MessageInitShape,
  setExtension,
} from '@bufbuild/protobuf';
import {
  DescriptorProtoSchema,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  FileOptionsSchema,
  MethodDescriptorProtoSchema,
  MethodOptionsSchema,
  ServiceDescriptorProtoSchema,
  ServiceOptionsSchema,
} from '@bufbuild/protobuf/wkt';

import { file_doric_models_v1_models } from '../../src/contracts/gen/doric/models/v1/models_pb.js';
import { file_doric_platform_log_v1_log } from '../../src/contracts/gen/doric/platform/log/v1/log_pb.js';
import {
  Cardinality,
  ContractOptionSchema,
  contract,
  Environment,
  Expose,
  file_doric_platform_v1_options,
  HooksOptionSchema,
  hooks,
  MethodOptionSchema,
  method,
  ServiceOptionSchema,
  ServiceRole,
  service,
} from '../../src/contracts/gen/doric/platform/v1/options_pb.js';
import { file_doric_regions_v1_regions } from '../../src/contracts/gen/doric/regions/v1/regions_pb.js';
import { file_doric_storage_v1_storage } from '../../src/contracts/gen/doric/storage/v1/storage_pb.js';
import { file_doric_tools_v1_tools } from '../../src/contracts/gen/doric/tools/v1/tools_pb.js';
import { createCatalogIndex } from '../../src/platform/catalog-index.js';

interface FixtureMethod {
  readonly name: string;
  readonly expose?: Expose;
  readonly resumable?: boolean;
  readonly serverStreaming?: boolean;
}

interface FixtureService {
  readonly name: string;
  readonly role?: ServiceRole;
  readonly methods: readonly FixtureMethod[];
}

interface FixtureSpec {
  readonly name: string;
  readonly package: string;
  readonly contract?: MessageInitShape<typeof ContractOptionSchema>;
  readonly hooksId?: string;
  readonly services?: readonly FixtureService[];
}

/** A `DescFile` built from a descriptor, importing only `options.proto`. */
const fixture = (spec: FixtureSpec): DescFile => {
  const options = create(FileOptionsSchema);

  if (spec.contract !== undefined) {
    setExtension(
      options,
      contract,
      create(ContractOptionSchema, spec.contract),
    );
  }

  if (spec.hooksId !== undefined) {
    setExtension(
      options,
      hooks,
      create(HooksOptionSchema, { id: spec.hooksId }),
    );
  }

  const proto = create(FileDescriptorProtoSchema, {
    name: spec.name,
    package: spec.package,
    syntax: 'proto3',
    dependency: ['doric/platform/v1/options.proto'],
    messageType: [
      create(DescriptorProtoSchema, { name: 'Request' }),
      create(DescriptorProtoSchema, { name: 'Response' }),
    ],
    service: (spec.services ?? []).map((entry) => {
      const serviceOptions = create(ServiceOptionsSchema);

      if (entry.role !== undefined) {
        setExtension(
          serviceOptions,
          service,
          create(ServiceOptionSchema, { role: entry.role }),
        );
      }

      return create(ServiceDescriptorProtoSchema, {
        name: entry.name,
        options: serviceOptions,
        method: entry.methods.map((rpc) => {
          const methodOptions = create(MethodOptionsSchema);

          if (rpc.expose !== undefined || rpc.resumable !== undefined) {
            setExtension(
              methodOptions,
              method,
              create(MethodOptionSchema, {
                expose: rpc.expose ?? Expose.UNSPECIFIED,
                resumable: rpc.resumable ?? false,
              }),
            );
          }

          return create(MethodDescriptorProtoSchema, {
            name: rpc.name,
            inputType: `.${spec.package}.Request`,
            outputType: `.${spec.package}.Response`,
            serverStreaming: rpc.serverStreaming ?? false,
            options: methodOptions,
          });
        }),
      });
    }),
    options,
  });
  const registry = createFileRegistry(proto, (name) =>
    name === file_doric_platform_v1_options.proto.name
      ? file_doric_platform_v1_options
      : undefined,
  );
  const file = registry.getFile(spec.name);

  assert.ok(file !== undefined, spec.name);

  return file;
};

const demoContract = (
  init: MessageInitShape<typeof ContractOptionSchema> = {},
): MessageInitShape<typeof ContractOptionSchema> => ({
  id: 'demo/v1',
  cardinality: Cardinality.MANY,
  environment: Environment.CLIENT,
  ...init,
});

describe('the catalog index over the generated files', () => {
  test('a handler method answers its contract, role, kind and options', () => {
    const index = createCatalogIndex([file_doric_tools_v1_tools]);
    const info = index.method('/doric.tools.v1.ToolHandlerService/Execute');

    assert.ok(info !== undefined);
    assert.equal(info.path, '/doric.tools.v1.ToolHandlerService/Execute');
    assert.equal(info.contract.id, 'tools/v1');
    assert.equal(info.role, 'handler');
    assert.equal(info.kind, 'unary');
    assert.equal(info.expose, 'NONE');
    assert.equal(info.resumable, false);
    assert.equal(info.service.typeName, 'doric.tools.v1.ToolHandlerService');
    assert.equal(info.method.name, 'Execute');
  });

  test("a contract's own method has the role contract and its exposure", () => {
    const index = createCatalogIndex([file_doric_tools_v1_tools]);
    const info = index.method('/doric.tools.v1.ToolsService/Catalog');

    assert.ok(info !== undefined);
    assert.equal(info.role, 'contract');
    assert.equal(info.expose, 'DESKTOP');
    assert.equal(info.contract.id, 'tools/v1');
  });

  test('a contract answers its cardinality, environment and file', () => {
    const index = createCatalogIndex([file_doric_tools_v1_tools]);
    const tools = index.contract('tools/v1');

    assert.ok(tools !== undefined);
    assert.equal(tools.cardinality, 'one');
    assert.equal(tools.environment, 'HOST');
    assert.equal(tools.file, file_doric_tools_v1_tools);
  });

  test('a service answers its contract, role and methods in declaration order', () => {
    const index = createCatalogIndex([file_doric_tools_v1_tools]);
    const own = index.service('doric.tools.v1.ToolsService');
    const handler = index.service('doric.tools.v1.ToolHandlerService');

    assert.ok(own !== undefined);
    assert.ok(handler !== undefined);
    assert.equal(own.contract.id, 'tools/v1');
    assert.equal(own.role, 'contract');
    assert.deepEqual(
      own.methods.map((entry) => entry.method.name),
      ['Register', 'Unregister', 'List', 'Catalog', 'Execute'],
    );
    assert.equal(handler.role, 'handler');
    assert.deepEqual(
      handler.methods.map((entry) => entry.path),
      [
        '/doric.tools.v1.ToolHandlerService/Check',
        '/doric.tools.v1.ToolHandlerService/Execute',
      ],
    );
  });

  test('methods are classified by their streaming shape', () => {
    const index = createCatalogIndex([
      file_doric_storage_v1_storage,
      file_doric_models_v1_models,
    ]);

    assert.equal(
      index.method('/doric.storage.v1.StorageService/Health')?.kind,
      'unary',
    );
    assert.equal(
      index.method('/doric.storage.v1.StorageService/Get')?.kind,
      'server_stream',
    );
    assert.equal(
      index.method('/doric.storage.v1.StorageService/Commit')?.kind,
      'client_stream',
    );
    assert.equal(
      index.method('/doric.models.v1.ModelsService/Stream')?.kind,
      'bidi',
    );
  });

  test('a resumable stream reads resumable; a stream without the option does not', () => {
    const index = createCatalogIndex([
      file_doric_regions_v1_regions,
      file_doric_storage_v1_storage,
    ]);
    const watch = index.method('/doric.regions.v1.RegionsService/Watch');

    assert.ok(watch !== undefined);
    assert.equal(watch.resumable, true);
    assert.equal(watch.contract.environment, 'CLIENT');
    assert.equal(
      index.method('/doric.storage.v1.StorageService/Get')?.resumable,
      false,
    );
  });

  test('a platform contract is PLATFORM', () => {
    const index = createCatalogIndex([file_doric_platform_log_v1_log]);
    const log = index.contract('doric.log/v1');

    assert.ok(log !== undefined);
    assert.equal(log.environment, 'PLATFORM');
    assert.equal(log.cardinality, 'one');
  });

  test('unknown keys answer undefined', () => {
    const index = createCatalogIndex([file_doric_tools_v1_tools]);

    assert.equal(
      index.method('/doric.tools.v1.ToolsService/Missing'),
      undefined,
    );
    assert.equal(
      index.method('/doric.missing.v1.MissingService/Get'),
      undefined,
    );
    assert.equal(index.service('doric.tools.v1.MissingService'), undefined);
    assert.equal(index.contract('missing/v1'), undefined);
  });

  test('the registry holds the files given and every file they import', () => {
    const index = createCatalogIndex([file_doric_tools_v1_tools]);

    assert.equal(
      index.registry.getFile('doric/tools/v1/tools.proto'),
      file_doric_tools_v1_tools,
    );
    assert.ok(
      index.registry.getFile('doric/platform/v1/options.proto') !== undefined,
    );
    assert.ok(
      index.registry.getFile('google/protobuf/descriptor.proto') !== undefined,
    );
  });

  test('desktopMethods lists exposed methods by file order, then declaration order', () => {
    const index = createCatalogIndex([
      file_doric_tools_v1_tools,
      file_doric_models_v1_models,
      file_doric_storage_v1_storage,
    ]);
    const paths = [
      '/doric.tools.v1.ToolsService/Catalog',
      '/doric.models.v1.ModelsService/Kinds',
      '/doric.models.v1.ModelsService/Kind',
      '/doric.models.v1.ModelsService/Catalog',
      '/doric.models.v1.ModelsService/Icons',
    ];

    assert.deepEqual(
      index.desktopMethods().map((entry) => entry.path),
      paths,
    );
    assert.equal(index.desktopMethods(), index.desktopMethods());

    const reversed = createCatalogIndex([
      file_doric_models_v1_models,
      file_doric_tools_v1_tools,
    ]);

    assert.deepEqual(
      reversed.desktopMethods().map((entry) => entry.path),
      [...paths.slice(1), paths[0]],
    );
  });

  test('a file given twice counts once', () => {
    const index = createCatalogIndex([
      file_doric_tools_v1_tools,
      file_doric_tools_v1_tools,
    ]);

    assert.deepEqual(
      index.desktopMethods().map((entry) => entry.path),
      ['/doric.tools.v1.ToolsService/Catalog'],
    );
    assert.equal(index.contract('tools/v1')?.file, file_doric_tools_v1_tools);
  });
});

describe('the catalog index over fixture files', () => {
  test('a hooks file is a HOOKS contract of cardinality one', () => {
    const file = fixture({
      name: 'demo/hooks/v1/hooks.proto',
      package: 'doric.demo.hooks.v1',
      hooksId: 'demo.hooks/v1',
    });
    const index = createCatalogIndex([file]);
    const info = index.contract('demo.hooks/v1');

    assert.ok(info !== undefined);
    assert.equal(info.environment, 'HOOKS');
    assert.equal(info.cardinality, 'one');
    assert.equal(info.file, file);
  });

  test('a fixture contract reads cardinality many, its environment, roles and method options', () => {
    const index = createCatalogIndex([
      fixture({
        name: 'demo/v1/demo.proto',
        package: 'doric.demo.v1',
        contract: demoContract(),
        services: [
          {
            name: 'DemoService',
            role: ServiceRole.UNSPECIFIED,
            methods: [
              {
                name: 'Watch',
                serverStreaming: true,
                resumable: true,
                expose: Expose.DESKTOP,
              },
            ],
          },
          {
            name: 'DemoHandlerService',
            role: ServiceRole.HANDLER,
            methods: [{ name: 'Run', expose: Expose.UNSPECIFIED }],
          },
        ],
      }),
    ]);
    const watch = index.method('/doric.demo.v1.DemoService/Watch');
    const run = index.method('/doric.demo.v1.DemoHandlerService/Run');

    assert.equal(index.contract('demo/v1')?.cardinality, 'many');
    assert.equal(index.contract('demo/v1')?.environment, 'CLIENT');
    assert.ok(watch !== undefined);
    assert.equal(watch.role, 'contract');
    assert.equal(watch.kind, 'server_stream');
    assert.equal(watch.resumable, true);
    assert.equal(watch.expose, 'DESKTOP');
    assert.ok(run !== undefined);
    assert.equal(run.role, 'handler');
    assert.equal(run.expose, 'NONE');
    assert.equal(run.resumable, false);
    assert.deepEqual(
      index.desktopMethods().map((entry) => entry.path),
      ['/doric.demo.v1.DemoService/Watch'],
    );
  });

  const refused: readonly (readonly [
    string,
    () => readonly DescFile[],
    readonly string[],
  ])[] = [
    [
      'two files declare one contract id',
      () => [
        fixture({
          name: 'demo/v1/a.proto',
          package: 'doric.demo.v1',
          contract: demoContract(),
        }),
        fixture({
          name: 'demo/v1/b.proto',
          package: 'doric.demo.v1',
          contract: demoContract(),
        }),
      ],
      ['demo/v1/a.proto', 'demo/v1/b.proto'],
    ],
    [
      'two different files have one name',
      () => [
        fixture({
          name: 'demo/v1/demo.proto',
          package: 'doric.demo.v1',
          contract: demoContract(),
        }),
        fixture({
          name: 'demo/v1/demo.proto',
          package: 'doric.other.v1',
          contract: demoContract({ id: 'other/v1' }),
        }),
      ],
      ['demo/v1/demo.proto'],
    ],
    [
      "a contract's cardinality is unspecified",
      () => [
        fixture({
          name: 'demo/v1/demo.proto',
          package: 'doric.demo.v1',
          contract: demoContract({
            cardinality: Cardinality.UNSPECIFIED,
          }),
        }),
      ],
      ['demo/v1/demo.proto'],
    ],
    [
      "a bundle's contract leaves environment unspecified",
      () => [
        fixture({
          name: 'demo/v1/demo.proto',
          package: 'doric.demo.v1',
          contract: demoContract({
            environment: Environment.UNSPECIFIED,
          }),
        }),
      ],
      ['demo/v1/demo.proto'],
    ],
    [
      'a platform contract sets an environment',
      () => [
        fixture({
          name: 'doric/platform/demo/v1/demo.proto',
          package: 'doric.platform.demo.v1',
          contract: demoContract({
            id: 'doric.demo/v1',
            cardinality: Cardinality.ONE,
            environment: Environment.HOST,
          }),
        }),
      ],
      ['doric/platform/demo/v1/demo.proto'],
    ],
  ];

  for (const [name, files, named] of refused) {
    test(`throws a TypeError naming the file when ${name}`, () => {
      const given = files();

      assert.throws(
        () => createCatalogIndex(given),
        (error: unknown) => {
          assert.ok(error instanceof TypeError, String(error));
          assert.ok(
            named.some((file) => error.message.includes(file)),
            error.message,
          );

          return true;
        },
      );
    });
  }
});

describe('the environments of the repository image (AC2.4, T2.15)', () => {
  test('every bundle contract states one environment and no hooks file states one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalog-index-'));

    try {
      const image = join(dir, 'image.binpb');
      const build = spawnSync(
        resolve('node_modules/.bin/buf'),
        ['build', '--as-file-descriptor-set', '-o', image],
        { encoding: 'utf8' },
      );

      assert.equal(build.status, 0, build.stderr);

      const set = fromBinary(FileDescriptorSetSchema, await readFile(image));
      const unstated: string[] = [];
      const hooksWithEnvironment: string[] = [];
      let contracts = 0;
      let hooksFiles = 0;

      for (const file of set.file) {
        const options = file.options;

        if (options === undefined) {
          continue;
        }

        const contractOption = hasExtension(options, contract)
          ? getExtension(options, contract)
          : undefined;

        if (hasExtension(options, hooks)) {
          hooksFiles += 1;

          if (contractOption !== undefined) {
            hooksWithEnvironment.push(file.name);
          }

          continue;
        }

        if (
          contractOption === undefined ||
          contractOption.id.startsWith('doric.')
        ) {
          continue;
        }

        contracts += 1;

        if (
          contractOption.environment !== Environment.HOST &&
          contractOption.environment !== Environment.CLIENT
        ) {
          unstated.push(`${file.name} (${contractOption.id})`);
        }
      }

      assert.ok(contracts > 0, 'the image holds bundle contracts');
      assert.ok(hooksFiles > 0, 'the image holds hooks files');
      assert.deepEqual(unstated, []);
      assert.deepEqual(hooksWithEnvironment, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
