// Small contract files built at run time for the gateway tests (spec
// `docs/designs/grpc-processes.md`, section 11): a contract service with a
// `DESKTOP` unary method `Echo`, a `DESKTOP` server-streaming method `Watch`
// and an unexposed `Hidden`, and a handler service with a `DESKTOP` method
// `Notify`. Every message is `{ string text = 1; }`, so its JSON is
// `{"text": "..."}`.

import assert from 'node:assert/strict';

import {
  create,
  createFileRegistry,
  type DescFile,
  type DescService,
  setExtension,
} from '@bufbuild/protobuf';
import {
  DescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FieldDescriptorProtoSchema,
  FileDescriptorProtoSchema,
  FileOptionsSchema,
  MethodDescriptorProtoSchema,
  MethodOptionsSchema,
  ServiceDescriptorProtoSchema,
  ServiceOptionsSchema,
} from '@bufbuild/protobuf/wkt';
import type { CallOptions } from '@connectrpc/connect';
// The module the generated files import, so that an index of a demo file and
// of generated files holds one `options.proto`.
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

export interface DemoSpec {
  /** The contract id, `demo/v1`. */
  readonly id: string;
  /** The proto package, `demo.v1`. */
  readonly package: string;
  /** `HOST` when undefined. */
  readonly environment?: Environment;
  /**
   * Whether `Watch` has `(doric.platform.v1.method).resumable = true`;
   * false when undefined.
   */
  readonly resumable?: boolean;
}

const text = () =>
  create(FieldDescriptorProtoSchema, {
    name: 'text',
    jsonName: 'text',
    number: 1,
    type: FieldDescriptorProto_Type.STRING,
    label: FieldDescriptorProto_Label.OPTIONAL,
  });

const rpc = (
  pkg: string,
  name: string,
  expose: Expose | undefined,
  serverStreaming = false,
  resumable = false,
) => {
  const options = create(MethodOptionsSchema);

  if (expose !== undefined || resumable) {
    setExtension(
      options,
      method,
      create(MethodOptionSchema, {
        ...(expose === undefined ? {} : { expose }),
        resumable,
      }),
    );
  }

  return create(MethodDescriptorProtoSchema, {
    name,
    inputType: `.${pkg}.Request`,
    outputType: `.${pkg}.Response`,
    serverStreaming,
    options,
  });
};

/** The contract file of `spec`: `<package>.DemoService` and `<package>.DemoHandlerService`. */
export const demoFile = (spec: DemoSpec): DescFile => {
  const options = create(FileOptionsSchema);

  setExtension(
    options,
    contract,
    create(ContractOptionSchema, {
      id: spec.id,
      cardinality: Cardinality.ONE,
      environment: spec.environment ?? Environment.HOST,
    }),
  );

  const handlerOptions = create(ServiceOptionsSchema);

  setExtension(
    handlerOptions,
    service,
    create(ServiceOptionSchema, { role: ServiceRole.HANDLER }),
  );

  const name = `${spec.package.replaceAll('.', '/')}/demo.proto`;
  const proto = create(FileDescriptorProtoSchema, {
    name,
    package: spec.package,
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    messageType: [
      create(DescriptorProtoSchema, { name: 'Request', field: [text()] }),
      create(DescriptorProtoSchema, { name: 'Response', field: [text()] }),
    ],
    service: [
      create(ServiceDescriptorProtoSchema, {
        name: 'DemoService',
        method: [
          rpc(spec.package, 'Echo', Expose.DESKTOP),
          rpc(
            spec.package,
            'Watch',
            Expose.DESKTOP,
            true,
            spec.resumable ?? false,
          ),
          rpc(spec.package, 'Hidden', undefined),
        ],
      }),
      create(ServiceDescriptorProtoSchema, {
        name: 'DemoHandlerService',
        options: handlerOptions,
        method: [rpc(spec.package, 'Notify', Expose.DESKTOP)],
      }),
    ],
    options,
  });
  const registry = createFileRegistry(proto, (imported) =>
    imported === file_doric_platform_v1_options.proto.name
      ? file_doric_platform_v1_options
      : undefined,
  );
  const file = registry.getFile(name);

  assert.ok(file !== undefined, name);

  return file;
};

/** The service named `name` of `file`. */
export const serviceOf = (file: DescFile, name: string): DescService => {
  const found = file.services.find((entry) => entry.name === name);

  assert.ok(found !== undefined, name);

  return found;
};

/** A message of the demo contract. */
export interface DemoMessage {
  readonly text: string;
}

/** A Connect client of `DemoService`, typed by hand for its dynamic messages. */
export interface DemoClient {
  echo(request: DemoMessage, options?: CallOptions): Promise<DemoMessage>;
  watch(
    request: DemoMessage,
    options?: CallOptions,
  ): AsyncIterable<DemoMessage>;
  hidden(request: DemoMessage, options?: CallOptions): Promise<DemoMessage>;
}
