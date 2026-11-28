// Internal to the client, not an entry of the package: the messages a set of
// files declares for storage types and stream prefixes, and the binary
// encoding of a value in chunks (spec `docs/designs/grpc-processes.md`, "The
// TypeScript client"; Q31's default: the client validates every value it
// writes with protovalidate).

import {
  type DescFile,
  type DescMessage,
  fromBinary,
  getOption,
  hasOption,
  type Message,
  toBinary,
} from '@bufbuild/protobuf';
import { createValidator } from '@bufbuild/protovalidate';
import { ContractError, closure } from 'bundle/contracts';
import {
  storage_type as storageTypeOption,
  stream_entry as streamEntryOption,
} from 'bundle/contracts/gen/doric/platform/v1/options_pb.js';

/** The messages a set of files declares, by type id and by stream prefix. */
export interface DeclaredMessages {
  /**
   * Each message with `(doric.platform.v1.storage_type)`, by its `type`.
   */
  readonly types: ReadonlyMap<string, DescMessage>;
  /**
   * Each message with `(doric.platform.v1.stream_entry)`, by its `prefix`
   * (`<owner>.<family>/`).
   */
  readonly streams: ReadonlyMap<string, DescMessage>;
}

/**
 * What a value's refusal names in `details`: a document's key, or the
 * stream an event is appended to.
 */
export type ValueKey =
  | { readonly type: string; readonly id: string }
  | { readonly stream: string };

/** The most bytes of one chunk, 1 MiB, as `storage.proto` bounds it. */
export const chunkBytes = 1_048_576;

/**
 * The storage types and stream prefixes `files` declare, and the messages
 * that declare them, searched in `files` and every file they import. Pure.
 * Throws `ContractError('invalid_input')` when two messages declare one type
 * or one prefix.
 */
export const messagesOf = (files: readonly DescFile[]): DeclaredMessages => {
  const types = new Map<string, DescMessage>();
  const streams = new Map<string, DescMessage>();
  const declare = (
    found: Map<string, DescMessage>,
    name: string,
    message: DescMessage,
  ): void => {
    const other = found.get(name);

    if (other !== undefined) {
      throw new ContractError(
        'invalid_input',
        `${other.typeName} and ${message.typeName} both declare ${name}.`,
      );
    }

    found.set(name, message);
  };

  for (const message of closure(files).flatMap((file) =>
    file.messages.flatMap(withNested),
  )) {
    if (hasOption(message, storageTypeOption)) {
      declare(types, getOption(message, storageTypeOption).type, message);
    }

    if (hasOption(message, streamEntryOption)) {
      declare(streams, getOption(message, streamEntryOption).prefix, message);
    }
  }

  return { types, streams };
};

/** `message` and every message nested in it, at any depth. */
const withNested = (message: DescMessage): DescMessage[] => [
  message,
  ...message.nestedMessages.flatMap(withNested),
];

const validator = createValidator();

/**
 * The binary encoding of `value`, a message of `schema`, unknown fields
 * kept, once it keeps every `buf.validate` rule of `schema`.
 *
 * Throws `ContractError('invalid_input')` with `key` as `details` when
 * `value.$typeName` is not `schema.typeName`, and when `value` breaks a rule:
 * then the message names the first violation, as protovalidate orders them.
 */
export const encodeValue = (
  schema: DescMessage,
  value: Message,
  key: ValueKey,
): Uint8Array => {
  if (value.$typeName !== schema.typeName) {
    throw new ContractError(
      'invalid_input',
      `The value is a ${value.$typeName}, not a ${schema.typeName}.`,
      key,
    );
  }

  const result = validator.validate(schema, value);

  if (result.kind !== 'valid') {
    throw new ContractError('invalid_input', result.error.message, key);
  }

  return toBinary(schema, value);
};

/**
 * `bytes` cut into consecutive chunks of at most `chunkBytes`, in order,
 * whose concatenation is `bytes`; none for empty bytes. Each chunk is a view
 * of `bytes`, not a copy. Pure.
 */
export const chunksOf = (bytes: Uint8Array): Uint8Array[] => {
  const chunks: Uint8Array[] = [];

  for (let start = 0; start < bytes.length; start += chunkBytes) {
    chunks.push(bytes.subarray(start, start + chunkBytes));
  }

  return chunks;
};

/**
 * The message of `schema` that `chunks`, joined in order, encode, unknown
 * fields kept; no chunk decodes as the empty message. Throws
 * `ContractError('invalid_output')` with `key` as `details` when the joined
 * bytes do not decode with `schema`.
 */
export const decodeValue = <M extends Message>(
  schema: DescMessage,
  chunks: readonly Uint8Array[],
  key: ValueKey,
): M => {
  const bytes = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.length, 0),
  );

  chunks.reduce((offset, chunk) => {
    bytes.set(chunk, offset);

    return offset + chunk.length;
  }, 0);

  try {
    return fromBinary(schema, bytes) as M;
  } catch (error) {
    throw new ContractError(
      'invalid_output',
      `The stored value does not decode as ${schema.typeName}: ${String(error)}.`,
      key,
    );
  }
};
