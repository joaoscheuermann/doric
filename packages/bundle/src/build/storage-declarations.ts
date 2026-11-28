// The storage build check (spec `docs/designs/grpc-processes.md`, "The
// storage contract", "Build check", A81, S79).

import {
  type DescFile,
  type DescMessage,
  getOption,
  hasOption,
} from '@bufbuild/protobuf';

import {
  storage_type as storageTypeOption,
  stream_entry as streamEntryOption,
} from '../contracts/gen/doric/platform/v1/options_pb.js';
import { type Manifest, parseContractEntry } from '../runtime/manifest.js';

/**
 * The well-known messages an index field may end at: their JSON form is a
 * string, a number or a boolean (engine `declarations.rs`).
 */
export const INDEXABLE_MESSAGES: readonly string[] = [
  'google.protobuf.Timestamp',
  'google.protobuf.Duration',
  'google.protobuf.DoubleValue',
  'google.protobuf.FloatValue',
  'google.protobuf.Int64Value',
  'google.protobuf.UInt64Value',
  'google.protobuf.Int32Value',
  'google.protobuf.UInt32Value',
  'google.protobuf.BoolValue',
  'google.protobuf.StringValue',
  'google.protobuf.BytesValue',
];

/** Build check of spec "The storage contract", "Build check" (A81, S79). Pure; never throws. */
export const checkStorageDeclarations = (input: {
  readonly manifest: Manifest;
  readonly files: readonly DescFile[];
}): readonly string[] => {
  const { manifest, files } = input;
  const owner = manifest.id;
  const provided = new Set(
    manifest.provides.map((entry) => parseContractEntry(entry)?.id),
  );
  const problems: string[] = [];

  const visit = (file: DescFile, message: DescMessage): void => {
    const where = file.proto.name;

    if (hasOption(message, streamEntryOption)) {
      const { prefix } = getOption(message, streamEntryOption);

      if (prefix.split('.')[0] !== owner) {
        problems.push(
          `${where}: the stream prefix "${prefix}" of ${message.typeName} is not of the bundle ${owner}.`,
        );
      }
    }

    if (hasOption(message, storageTypeOption)) {
      const { type, indexes } = getOption(message, storageTypeOption);

      if (type.split(/[./]/)[0] !== owner) {
        problems.push(
          `${where}: the storage type "${type}" of ${message.typeName} is not of the bundle ${owner}.`,
        );
      }

      if (!provided.has(type)) {
        problems.push(
          `${where}: the storage type "${type}" of ${message.typeName} is not declared in provides.`,
        );
      }

      for (const index of indexes) {
        for (const field of index.fields) {
          if (!indexable(message, field)) {
            problems.push(
              `${where}: the field "${field}" of the index "${index.name}" of "${type}" is not a singular scalar, enum, Timestamp, Duration or wrapper reached through singular messages, by JSON names.`,
            );
          }
        }
      }
    }

    for (const nested of message.nestedMessages) {
      visit(file, nested);
    }
  };

  for (const file of files) {
    for (const message of file.messages) {
      visit(file, message);
    }
  }

  return problems;
};

/**
 * Whether `path`, JSON names separated by `.`, passes from `message` through
 * singular message fields, none of them well-known, to a singular scalar or
 * enum field, or to a Timestamp, Duration or wrapper.
 */
const indexable = (message: DescMessage, path: string): boolean => {
  let current = message;
  const segments = path.split('.');

  for (const [position, segment] of segments.entries()) {
    const field = current.fields.find(
      (candidate) => candidate.jsonName === segment,
    );
    const last = position === segments.length - 1;

    if (field === undefined) {
      return false;
    }

    switch (field.fieldKind) {
      case 'scalar':
      case 'enum':
        return last;
      case 'message':
        if (last) {
          return INDEXABLE_MESSAGES.includes(field.message.typeName);
        }

        if (field.message.typeName.startsWith('google.protobuf.')) {
          return false;
        }

        current = field.message;
        break;
      default:
        return false;
    }
  }

  return false;
};
