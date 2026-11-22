// A contract file built at run time with the shape of
// `runtime.threads/v1.WatchThread` (spec `docs/designs/grpc-processes.md`,
// section 3, "Size", item 2; T2.12), whose real contract is not generated in
// this package: `fixture.threads.v1.ThreadsService.WatchThread` is server
// streaming, and each of its items is a oneof of a `snapshot` (the events up
// to now) and one `event` after the snapshot's last.
//
// ```proto
// message Event { uint32 sequence = 1; bytes payload = 2; }
// message Snapshot { repeated Event events = 1; }
// message WatchThreadRequest { string thread_id = 1; }
// message WatchThreadResponse {
//   oneof item { Snapshot snapshot = 1; Event event = 2; }
// }
// service ThreadsService {
//   rpc WatchThread(WatchThreadRequest) returns (stream WatchThreadResponse);
// }
// ```

import assert from 'node:assert/strict';

import {
  create,
  createFileRegistry,
  type DescFile,
  type DescMessage,
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
  OneofDescriptorProtoSchema,
  ServiceDescriptorProtoSchema,
} from '@bufbuild/protobuf/wkt';
// The module the generated files import, so that an index of this file and of
// generated files holds one `options.proto` (see `demo-contract.ts`).
import {
  Cardinality,
  ContractOptionSchema,
  contract,
  Environment,
  file_doric_platform_v1_options,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

/** The contract id of the fixture. */
export const watchThreadContractId = 'fixture.threads/v1';

const pkg = 'fixture.threads.v1';
const name = 'fixture/threads/v1/threads.proto';

const field = (
  fieldName: string,
  jsonName: string,
  number: number,
  type: FieldDescriptorProto_Type,
  extra: {
    readonly typeName?: string;
    readonly repeated?: boolean;
    readonly oneofIndex?: number;
  } = {},
) =>
  create(FieldDescriptorProtoSchema, {
    name: fieldName,
    jsonName,
    number,
    type,
    label: extra.repeated
      ? FieldDescriptorProto_Label.REPEATED
      : FieldDescriptorProto_Label.OPTIONAL,
    ...(extra.typeName === undefined ? {} : { typeName: extra.typeName }),
    ...(extra.oneofIndex === undefined ? {} : { oneofIndex: extra.oneofIndex }),
  });

/** The fixture's contract file: `fixture.threads.v1.ThreadsService`. */
export const watchThreadFile = (): DescFile => {
  const options = create(FileOptionsSchema);

  setExtension(
    options,
    contract,
    create(ContractOptionSchema, {
      id: watchThreadContractId,
      cardinality: Cardinality.ONE,
      environment: Environment.HOST,
    }),
  );

  const proto = create(FileDescriptorProtoSchema, {
    name,
    package: pkg,
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    messageType: [
      create(DescriptorProtoSchema, {
        name: 'Event',
        field: [
          field('sequence', 'sequence', 1, FieldDescriptorProto_Type.UINT32),
          field('payload', 'payload', 2, FieldDescriptorProto_Type.BYTES),
        ],
      }),
      create(DescriptorProtoSchema, {
        name: 'Snapshot',
        field: [
          field('events', 'events', 1, FieldDescriptorProto_Type.MESSAGE, {
            typeName: `.${pkg}.Event`,
            repeated: true,
          }),
        ],
      }),
      create(DescriptorProtoSchema, {
        name: 'WatchThreadRequest',
        field: [
          field('thread_id', 'threadId', 1, FieldDescriptorProto_Type.STRING),
        ],
      }),
      create(DescriptorProtoSchema, {
        name: 'WatchThreadResponse',
        field: [
          field('snapshot', 'snapshot', 1, FieldDescriptorProto_Type.MESSAGE, {
            typeName: `.${pkg}.Snapshot`,
            oneofIndex: 0,
          }),
          field('event', 'event', 2, FieldDescriptorProto_Type.MESSAGE, {
            typeName: `.${pkg}.Event`,
            oneofIndex: 0,
          }),
        ],
        oneofDecl: [create(OneofDescriptorProtoSchema, { name: 'item' })],
      }),
    ],
    service: [
      create(ServiceDescriptorProtoSchema, {
        name: 'ThreadsService',
        method: [
          create(MethodDescriptorProtoSchema, {
            name: 'WatchThread',
            inputType: `.${pkg}.WatchThreadRequest`,
            outputType: `.${pkg}.WatchThreadResponse`,
            serverStreaming: true,
          }),
        ],
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

/** The message named `messageName` of `file`. */
export const messageOf = (file: DescFile, messageName: string): DescMessage => {
  const found = file.messages.find((entry) => entry.name === messageName);

  assert.ok(found !== undefined, messageName);

  return found;
};

/** The service named `serviceName` of `file`. */
export const serviceOf = (file: DescFile, serviceName: string): DescService => {
  const found = file.services.find((entry) => entry.name === serviceName);

  assert.ok(found !== undefined, serviceName);

  return found;
};

/** An event of the fixture. */
export interface WatchEvent {
  readonly sequence: number;
  readonly payload: Uint8Array;
}

/** An item of `WatchThread`, as the caller reads it. */
export interface WatchThreadItem {
  readonly item:
    | { readonly case: 'snapshot'; readonly value: { events: WatchEvent[] } }
    | { readonly case: 'event'; readonly value: WatchEvent }
    | { readonly case: undefined; readonly value?: undefined };
}

/** A Connect client of `ThreadsService`, typed by hand for its dynamic messages. */
export interface ThreadsClient {
  watchThread(request: { threadId: string }): AsyncIterable<WatchThreadItem>;
}
