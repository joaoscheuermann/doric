// Fixtures for the descriptors of a bundle (spec `docs/designs/grpc-processes.md`,
// section 8, "Descriptors"): serialized `FileDescriptorSet`s of generated
// files, a bundle whose `dist/contracts/gen` holds a generated-style module,
// and a summary of a catalog index that two indexes can be compared by.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  create,
  createFileRegistry,
  type DescFile,
  type MessageInitShape,
  setExtension,
  toBinary,
} from '@bufbuild/protobuf';
import { base64Encode } from '@bufbuild/protobuf/wire';
import {
  DescriptorProtoSchema,
  type FileDescriptorProto,
  FileDescriptorProtoSchema,
  FileDescriptorSetSchema,
  FileOptionsSchema,
  MethodDescriptorProtoSchema,
  MethodOptionsSchema,
  ServiceDescriptorProtoSchema,
  ServiceOptionsSchema,
} from '@bufbuild/protobuf/wkt';
import {
  Cardinality,
  ContractOptionSchema,
  contract,
  Environment,
  Expose,
  file_doric_platform_v1_options,
  MethodOptionSchema,
  method,
  ServiceOptionSchema,
  ServiceRole,
  service,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

import type { CatalogIndex } from '../../src/platform/catalog-index.js';
import { manifest, writeBundle } from './fixtures.js';

/** The files of `files` and every file they import, transitively, each once, imports first. */
export const closure = (...files: readonly DescFile[]): DescFile[] => {
  const seen = new Set<string>();
  const ordered: DescFile[] = [];
  const visit = (file: DescFile): void => {
    if (seen.has(file.proto.name)) {
      return;
    }

    seen.add(file.proto.name);

    for (const dependency of file.dependencies) {
      visit(dependency);
    }

    ordered.push(file);
  };

  for (const file of files) {
    visit(file);
  }

  return ordered;
};

/** The binary `FileDescriptorSet` of exactly `protos`, in order. */
export const setOfProtos = (
  protos: readonly FileDescriptorProto[],
): Uint8Array =>
  toBinary(
    FileDescriptorSetSchema,
    create(FileDescriptorSetSchema, { file: [...protos] }),
  );

/** The binary `FileDescriptorSet` of `files` and their imports, imports first. */
export const setOf = (...files: readonly DescFile[]): Uint8Array =>
  setOfProtos(closure(...files).map((file) => file.proto));

/**
 * A contract file importing only `options.proto`: `<name>` of package
 * `<pkg>` with the option `contract`, a contract service `DemoService`
 * (`Ping` exposed to DESKTOP, `Watch` a resumable server stream) and a
 * handler service `DemoHandlerService` (`Run`).
 */
export const contractProto = (spec: {
  readonly name: string;
  readonly package: string;
  readonly contract: MessageInitShape<typeof ContractOptionSchema>;
}): FileDescriptorProto => {
  const options = create(FileOptionsSchema);

  setExtension(options, contract, create(ContractOptionSchema, spec.contract));

  const rpc = (
    name: string,
    init: MessageInitShape<typeof MethodOptionSchema> | undefined,
    serverStreaming = false,
  ) => {
    const methodOptions = create(MethodOptionsSchema);

    if (init !== undefined) {
      setExtension(methodOptions, method, create(MethodOptionSchema, init));
    }

    return create(MethodDescriptorProtoSchema, {
      name,
      inputType: `.${spec.package}.Request`,
      outputType: `.${spec.package}.Response`,
      serverStreaming,
      options: methodOptions,
    });
  };
  const handlerOptions = create(ServiceOptionsSchema);

  setExtension(
    handlerOptions,
    service,
    create(ServiceOptionSchema, { role: ServiceRole.HANDLER }),
  );

  return create(FileDescriptorProtoSchema, {
    name: spec.name,
    package: spec.package,
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    messageType: [
      create(DescriptorProtoSchema, { name: 'Request' }),
      create(DescriptorProtoSchema, { name: 'Response' }),
    ],
    service: [
      create(ServiceDescriptorProtoSchema, {
        name: 'DemoService',
        method: [
          rpc('Ping', { expose: Expose.DESKTOP }),
          rpc('Watch', { resumable: true }, true),
        ],
      }),
      create(ServiceDescriptorProtoSchema, {
        name: 'DemoHandlerService',
        options: handlerOptions,
        method: [rpc('Run', undefined)],
      }),
    ],
    options,
  });
};

/** `demo/v1/demo.proto`: the contract `demo.api/v1`, ONE, HOST. */
export const demoProto = (): FileDescriptorProto =>
  contractProto({
    name: 'demo/v1/demo.proto',
    package: 'demo.v1',
    contract: {
      id: 'demo.api/v1',
      cardinality: Cardinality.ONE,
      environment: Environment.HOST,
    },
  });

/** A `DescFile` of `proto`, resolving its imports among `imports`. */
export const descFileOf = (
  proto: FileDescriptorProto,
  imports: readonly DescFile[] = [file_doric_platform_v1_options],
): DescFile => {
  const registry = createFileRegistry(proto, (name) =>
    imports.find((file) => file.proto.name === name),
  );
  const file = registry.getFile(proto.name);

  if (file === undefined) {
    throw new Error(`${proto.name} is not in its registry`);
  }

  return file;
};

/**
 * The source of a module as protoc-gen-es generates it for `demo.proto`:
 * `file_demo_v1_demo`, hydrated with `fileDesc`, importing the options file
 * through this package's export, as the generated code of a bundle does.
 */
const demoModule = (): string => `import { fileDesc } from ${JSON.stringify(
  import.meta.resolve('@bufbuild/protobuf/codegenv2'),
)};
import { file_doric_platform_v1_options } from ${JSON.stringify(
  import.meta.resolve('bundle/contracts/gen/doric/platform/v1/options_pb.js'),
)};

export const file_demo_v1_demo = /*@__PURE__*/ fileDesc(${JSON.stringify(
  base64Encode(toBinary(FileDescriptorProtoSchema, demoProto())),
)}, [file_doric_platform_v1_options]);
`;

/** The path of the generated demo module below a bundle directory. */
export const demoModulePath = (bundleDir: string): string =>
  join(bundleDir, 'dist', 'contracts', 'gen', 'demo', 'v1', 'demo_pb.js');

/**
 * Writes the bundle `<root>/<directory>` (id `id`, manifest version 1, no
 * parts) whose `dist/contracts/gen/demo/v1/demo_pb.js` is the generated
 * module of `demo.proto`, as tsc leaves it after `buf generate`.
 */
export const writeContractBundle = async (
  root: string,
  directory = 'demo',
  id = 'demo',
): Promise<string> =>
  writeBundle(root, directory, {
    manifest: manifest(id),
    files: { 'dist/contracts/gen/demo/v1/demo_pb.js': demoModule() },
  });

/** The `DescFile` the generated demo module of `bundleDir` exports. */
export const importDemoFile = async (bundleDir: string): Promise<DescFile> => {
  const loaded = (await import(
    pathToFileURL(demoModulePath(bundleDir)).href
  )) as { readonly file_demo_v1_demo: DescFile };

  return loaded.file_demo_v1_demo;
};

/**
 * What an index answers, in plain values: the names of the files of its
 * registry (sorted), every service of those files the index knows with its
 * contract, role and methods (sorted by name), and the paths of
 * `desktopMethods()` in their order.
 */
export const summarize = (index: CatalogIndex) => {
  const files = [...index.registry.files];

  return {
    files: files.map((file) => file.proto.name).sort(),
    services: files
      .flatMap((file) => file.services)
      .flatMap((descriptor) => {
        const info = index.service(descriptor.typeName);

        return info === undefined
          ? []
          : [
              {
                name: descriptor.typeName,
                role: info.role,
                contract: {
                  id: info.contract.id,
                  cardinality: info.contract.cardinality,
                  environment: info.contract.environment,
                  file: info.contract.file.proto.name,
                },
                methods: info.methods.map((entry) => ({
                  path: entry.path,
                  kind: entry.kind,
                  role: entry.role,
                  expose: entry.expose,
                  resumable: entry.resumable,
                  contract: entry.contract.id,
                  found: index.method(entry.path)?.path,
                })),
              },
            ];
      })
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    desktop: index.desktopMethods().map((entry) => entry.path),
  };
};
