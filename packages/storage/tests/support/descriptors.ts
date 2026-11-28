// Descriptor files the `storage/v2` client tests build at run time
// (`storage-client.test.ts`, `test-engine.test.ts`): a storage type of any
// bundle, a stream entry of `conformance`, and a file whose descriptor set is
// larger than `Register` takes. Each is a `DescFile` as `protoc-gen-es`
// would generate it, importing `doric/platform/v1/options.proto`.

import {
  create,
  createFileRegistry,
  type DescFile,
  type DescMessage,
  type Message,
  setExtension,
} from '@bufbuild/protobuf';
import {
  type DescriptorProto,
  DescriptorProtoSchema,
  FieldDescriptorProto_Label,
  FieldDescriptorProto_Type,
  FileDescriptorProtoSchema,
  MessageOptionsSchema,
} from '@bufbuild/protobuf/wkt';
import {
  file_doric_platform_v1_options,
  StorageTypeOptionSchema,
  StreamEntryOptionSchema,
  storage_type,
  stream_entry,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

/** What a message of these files declares, beside its `string text = 1`. */
type Declaration =
  | { readonly storageType: string }
  | { readonly streamPrefix: string }
  | Record<string, never>;

/** A message `name` with the one field `string text = 1`, and `declaration`. */
const messageProto = (
  name: string,
  declaration: Declaration,
): DescriptorProto => {
  const options = create(MessageOptionsSchema);

  if ('storageType' in declaration) {
    setExtension(
      options,
      storage_type,
      create(StorageTypeOptionSchema, { type: declaration.storageType }),
    );
  } else if ('streamPrefix' in declaration) {
    setExtension(
      options,
      stream_entry,
      create(StreamEntryOptionSchema, { prefix: declaration.streamPrefix }),
    );
  }

  return create(DescriptorProtoSchema, {
    name,
    field: [
      {
        name: 'text',
        number: 1,
        jsonName: 'text',
        type: FieldDescriptorProto_Type.STRING,
        label: FieldDescriptorProto_Label.OPTIONAL,
      },
    ],
    options,
  });
};

/** The file `name` of package `pkg` with `messages`, importing the options. */
const fileOf = (
  name: string,
  pkg: string,
  messages: readonly DescriptorProto[],
): DescFile => {
  const proto = create(FileDescriptorProtoSchema, {
    name,
    package: pkg,
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    messageType: [...messages],
  });
  const registry = createFileRegistry(proto, (imported) =>
    imported === file_doric_platform_v1_options.proto.name
      ? file_doric_platform_v1_options
      : undefined,
  );
  const file = registry.getFile(name);

  if (file === undefined) {
    throw new Error(`the registry holds no ${name}`);
  }

  return file;
};

/** A file of `bundleId` and the messages it declares. */
export interface ItemFile {
  readonly file: DescFile;
  /** The message of the storage type `<bundleId>.item/v1`, `{ text }`. */
  readonly item: DescMessage;
}

/**
 * A file that declares the storage type `<bundleId>.item/v1`, no index,
 * with the message `Item { string text = 1; }`; with `extra`, also the
 * type `<bundleId>.<extra>/v1` of a second message, `Extra`.
 */
export const itemFile = (bundleId: string, extra?: string): ItemFile => {
  const pkg = `doric.storage.test.${bundleId.replaceAll(/[^a-z0-9]/g, '_')}.v1`;
  const messages = [
    messageProto('Item', { storageType: `${bundleId}.item/v1` }),
  ];

  if (extra !== undefined) {
    messages.push(
      messageProto('Extra', { storageType: `${bundleId}.${extra}/v1` }),
    );
  }

  const name = `doric/storage/test/${bundleId}${extra === undefined ? '' : `-${extra}`}.proto`;
  const file = fileOf(name, pkg, messages);
  const item = file.messages.find((message) => message.name === 'Item');

  if (item === undefined) {
    throw new Error('the file declares no Item');
  }

  return { file, item };
};

/** A value of an `ItemFile`'s `item`. */
export const itemOf = (item: DescMessage, text: string): Message =>
  create(item, { text }) as Message;

/**
 * A file of `conformance` that declares the stream prefix
 * `conformance.feed/`, with the message `FeedEvent { string text = 1; }`.
 */
export const feedFile = (): {
  readonly file: DescFile;
  readonly event: DescMessage;
} => {
  const file = fileOf(
    'doric/storage/test/conformance-feed.proto',
    'doric.storage.test.feed.v1',
    [messageProto('FeedEvent', { streamPrefix: 'conformance.feed/' })],
  );
  const [event] = file.messages;

  if (event === undefined) {
    throw new Error('the file declares no FeedEvent');
  }

  return { file, event };
};

/**
 * A file of `bundleId` that declares the storage type
 * `<bundleId>.big/v1`, padded with `count` messages whose names are 1,000
 * characters long, so its descriptor set holds more than `count` KB.
 */
export const oversizedFile = (bundleId: string, count = 2_200): DescFile =>
  fileOf(
    `doric/storage/test/${bundleId}-big.proto`,
    'doric.storage.test.big.v1',
    [
      messageProto('Big', { storageType: `${bundleId}.big/v1` }),
      ...Array.from({ length: count }, (_, index) =>
        messageProto(
          `Pad${String(index).padStart(5, '0')}${'X'.repeat(992)}`,
          {},
        ),
      ),
    ],
  );
