/**
 * Descriptor files the `storage/v2` cases build at run time (test support,
 * OQ10): the shapes `withIndexes` cannot make. A stream prefix with its
 * event and a fold document for the stream cases (skipped until S78), a
 * type of another bundle, the declarations `Register` refuses, and the
 * conformance file with a message left out. Each is a `DescFile` as
 * `protoc-gen-es` would generate it, importing
 * `doric/platform/v1/options.proto`. `src/` cannot import `tests/`, so
 * this is not `tests/support/descriptors.ts`.
 */
import {
  clone,
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

import type { IndexDeclaration } from './support.js';

/** One field of a run-time message; numbered by its position from 1. */
interface FieldSpec {
  /** A lower-case word: it is also the field's JSON name. */
  readonly name: string;
  readonly kind: 'string' | 'uint32';
  readonly repeated?: boolean;
}

/** One run-time message and what it declares. */
export interface MessageSpec {
  readonly name: string;
  readonly fields: readonly FieldSpec[];
  /** Declares the storage type with `indexes`. */
  readonly storageType?: string;
  readonly indexes?: readonly IndexDeclaration[];
  /** Declares the stream prefix instead. */
  readonly streamPrefix?: string;
}

const messageProto = (spec: MessageSpec): DescriptorProto => {
  const options = create(MessageOptionsSchema);

  if (spec.storageType !== undefined) {
    setExtension(
      options,
      storage_type,
      create(StorageTypeOptionSchema, {
        type: spec.storageType,
        indexes: (spec.indexes ?? []).map((index) => ({
          name: index.name,
          fields: [...index.fields],
          ...(index.unique === undefined ? {} : { unique: index.unique }),
        })),
      }),
    );
  } else if (spec.streamPrefix !== undefined) {
    setExtension(
      options,
      stream_entry,
      create(StreamEntryOptionSchema, { prefix: spec.streamPrefix }),
    );
  }

  return create(DescriptorProtoSchema, {
    name: spec.name,
    field: spec.fields.map((field, index) => ({
      name: field.name,
      number: index + 1,
      jsonName: field.name,
      type:
        field.kind === 'string'
          ? FieldDescriptorProto_Type.STRING
          : FieldDescriptorProto_Type.UINT32,
      label:
        field.repeated === true
          ? FieldDescriptorProto_Label.REPEATED
          : FieldDescriptorProto_Label.OPTIONAL,
    })),
    options,
  });
};

/** Every file `file` imports, directly or not, by its `.proto` name. */
const importsOf = (file: DescFile): Map<string, DescFile> => {
  const found = new Map<string, DescFile>();
  const visit = (current: DescFile): void => {
    for (const imported of current.dependencies) {
      if (!found.has(imported.proto.name)) {
        found.set(imported.proto.name, imported);
        visit(imported);
      }
    }
  };

  visit(file);

  return found;
};

/** The file `name` of package `pkg` declaring `messages`. */
const fileOf = (
  name: string,
  pkg: string,
  messages: readonly MessageSpec[],
): DescFile => {
  const proto = create(FileDescriptorProtoSchema, {
    name,
    package: pkg,
    syntax: 'proto3',
    dependency: [file_doric_platform_v1_options.proto.name],
    messageType: messages.map(messageProto),
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

/** The message `name` of `file`. */
const messageOf = (file: DescFile, name: string): DescMessage => {
  const found = file.messages.find((message) => message.name === name);

  if (found === undefined) {
    throw new Error(`${file.proto.name} declares no ${name}`);
  }

  return found;
};

/**
 * A copy of `file` without its top-level message `name`, everything else,
 * its name and package included, unchanged.
 */
export const without = (file: DescFile, name: string): DescFile => {
  const proto = clone(FileDescriptorProtoSchema, file.proto);

  proto.messageType = proto.messageType.filter(
    (message) => message.name !== name,
  );

  const imports = importsOf(file);
  const copy = createFileRegistry(proto, (imported) =>
    imports.get(imported),
  ).getFile(file.proto.name);

  if (copy === undefined) {
    throw new Error(`the registry holds no ${file.proto.name}`);
  }

  return copy;
};

/** The stream prefix of `streamFiles`. */
export const eventPrefix = 'conformance.note.events/';
/** The storage type of `streamFiles`' `Fold`. */
export const fold = 'conformance.fold/v1';

/** What the stream cases register beside the conformance file. */
export interface StreamFiles {
  readonly file: DescFile;
  /** `NoteEvent { string text = 1; }`, the entry of `eventPrefix`. */
  readonly event: DescMessage;
  /** `Fold { uint32 cursor = 1; repeated string seen = 2; }`, `fold`. */
  readonly fold: DescMessage;
}

/** The stream prefix `conformance.note.events/` and the type `fold`. */
export const streamFiles = (): StreamFiles => {
  const file = fileOf(
    'doric/storage/test/conformance-v2-streams.proto',
    'doric.storage.test.streams.v1',
    [
      {
        name: 'NoteEvent',
        fields: [{ name: 'text', kind: 'string' }],
        streamPrefix: eventPrefix,
      },
      {
        name: 'Fold',
        fields: [
          { name: 'cursor', kind: 'uint32' },
          { name: 'seen', kind: 'string', repeated: true },
        ],
        storageType: fold,
      },
    ],
  );

  return {
    file,
    event: messageOf(file, 'NoteEvent'),
    fold: messageOf(file, 'Fold'),
  };
};

/** The storage type of `otherFiles`. */
export const otherItem = 'other.item/v1';

/** A file of the bundle `other`: the type `other.item/v1`, `Item { text }`. */
export const otherFiles = (): {
  readonly file: DescFile;
  readonly item: DescMessage;
} => {
  const file = fileOf(
    'doric/storage/test/other-v2.proto',
    'doric.storage.test.other.v1',
    [
      {
        name: 'Item',
        fields: [{ name: 'text', kind: 'string' }],
        storageType: otherItem,
      },
    ],
  );

  return { file, item: messageOf(file, 'Item') };
};

/** A value of `message` with its one string field `text`. */
export const textOf = (message: DescMessage, text: string): Message =>
  create(message, { text }) as Message;

/** A file of `conformance` declaring each of `messages` and nothing else. */
export const conformanceFile = (
  suffix: string,
  messages: readonly MessageSpec[],
): DescFile =>
  fileOf(
    `doric/storage/test/conformance-${suffix}.proto`,
    `doric.storage.test.${suffix}.v1`,
    messages,
  );
