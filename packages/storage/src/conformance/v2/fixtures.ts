/**
 * Values, keys and readers the `storage/v2` cases share (test support, not
 * part of the kit's contract): puts of the conformance messages, a stored
 * document in protobuf's JSON form for `deepEqual`, query ids, the KV
 * state, and raw calls whose `ConnectError` becomes a `ContractError`.
 */
import assert from 'node:assert/strict';

import {
  create,
  type DescMessage,
  type JsonValue,
  type MessageInitShape,
  toBinary,
  toJson,
} from '@bufbuild/protobuf';
import { ConnectError } from '@connectrpc/connect';
import { fromConnectError } from 'bundle/contracts';

import type {
  DocumentKey,
  DocumentPut,
  Storage,
  StorageQuery,
  StoredDocument,
} from '../../client/types.js';
import {
  type Note,
  NoteSchema,
  PlainSchema,
  ThreadSchema,
} from '../../contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import { dump, type Entry } from '../kv/support.js';
import { conformanceFiles, type V2Harness } from './harness.js';
import { type IndexDeclaration, ids, withIndexes } from './support.js';

export const note = 'conformance.note/v1';
export const thread = 'conformance.thread/v1';
export const plain = 'conformance.plain/v1';

export const noteKey = (id: string): DocumentKey => ({ type: note, id });
export const threadKey = (id: string): DocumentKey => ({ type: thread, id });
export const plainKey = (id: string): DocumentKey => ({ type: plain, id });

export const notePut = (
  id: string,
  init: MessageInitShape<typeof NoteSchema>,
): DocumentPut => ({ type: note, id, value: create(NoteSchema, init) });

export const threadPut = (
  id: string,
  init: MessageInitShape<typeof ThreadSchema>,
): DocumentPut => ({ type: thread, id, value: create(ThreadSchema, init) });

export const plainPut = (id: string, text: string): DocumentPut => ({
  type: plain,
  id,
  value: create(PlainSchema, { text }),
});

const schemas: Readonly<Record<string, DescMessage>> = {
  [note]: NoteSchema,
  [thread]: ThreadSchema,
  [plain]: PlainSchema,
};

/** A stored document as the cases compare it: its value as protobuf JSON. */
interface View {
  readonly type: string;
  readonly id: string;
  readonly revision: number;
  readonly value: JsonValue;
}

/** `document` with its value in protobuf's JSON form, or `undefined`. */
export const view = (
  document: StoredDocument | undefined,
  schema?: DescMessage,
): View | undefined => {
  if (document === undefined) {
    return undefined;
  }

  const of = schema ?? schemas[document.type];

  if (of === undefined) {
    throw new Error(`no message for ${document.type}`);
  }

  return {
    type: document.type,
    id: document.id,
    revision: document.revision,
    value: toJson(of, document.value),
  };
};

/** The expected `View` of a document. */
export const stored = (
  key: DocumentKey,
  revision: number,
  value: JsonValue,
): View => ({ ...key, revision, value });

/** The views of `keys`, in order, `undefined` for an absent one. */
export const views = (
  storage: Storage,
  keys: readonly DocumentKey[],
): Promise<(View | undefined)[]> =>
  Promise.all(keys.map(async (key) => view(await storage.get(key))));

/** The revisions of `keys`, `undefined` for an absent one. */
export const revisions = (
  storage: Storage,
  keys: readonly DocumentKey[],
): Promise<(number | undefined)[]> =>
  Promise.all(keys.map(async (key) => (await storage.get(key))?.revision));

/** A query with `limit` 1,000 unless given. */
export type Lookup = Omit<StorageQuery, 'limit'> & { readonly limit?: number };

/** The ids of one page of `query`, `limit` 1,000 unless given. */
export const idsOf = async (
  storage: Storage,
  query: Lookup,
): Promise<string[]> => ids(await storage.query({ limit: 1000, ...query }));

/** Every KV entry of the engine, keys and values in hex, with versions. */
export const state = (harness: V2Harness): Promise<Entry[]> =>
  dump(harness.engine);

/** `run`'s result, its `ConnectError` turned into a `ContractError`. */
export const contract = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw error instanceof ConnectError ? fromConnectError(error) : error;
  }
};

/** `items` as the request stream of a client-streaming raw call. */
export async function* streamOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}

/** Reads `answer` to its end. */
export const drain = async (answer: AsyncIterable<unknown>): Promise<void> => {
  for await (const _ of answer) {
    // Only the end, or the refusal, matters.
  }
};

/**
 * Every entry of `stream` after `afterSequence` as `[sequence, text]`,
 * read `limit` at a time; each value has a string field `text`.
 */
export const entries = async (
  storage: Storage,
  stream: string,
  afterSequence = 0,
  limit = 100,
): Promise<[number, string][]> => {
  const out: [number, string][] = [];

  for (let after = afterSequence; ; ) {
    const page = await storage.read({ stream, afterSequence: after, limit });
    const last = page.entries.at(-1);

    if (last === undefined) {
      return out;
    }

    out.push(
      ...page.entries.map(({ sequence, value }): [number, string] => [
        sequence,
        (value as unknown as { readonly text: string }).text,
      ]),
    );
    after = last.sequence;
  }
};

/** The most bytes of one document's binary value (`limit` `"document"`). */
export const documentBytes = 16_777_216;

/**
 * A `Note` titled `title` whose binary value is exactly `bytes` long, for
 * `bytes` from 2^21 + 16 to 2^28: the rest is `body`, a field of tag 1 byte
 * and a 4-byte length, filled with a repeating pattern.
 */
export const sizedNote = (title: string, bytes: number): Note => {
  const head = toBinary(NoteSchema, create(NoteSchema, { title })).length;
  const body = new Uint8Array(bytes - head - 5).map((_, index) => index % 251);
  const value = create(NoteSchema, { title, body });

  assert.equal(toBinary(NoteSchema, value).length, bytes, 'the value size');

  return value;
};

/** Integers from 0 to `count - 1`. */
export const range = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index);

/** `index` padded to `width` digits, so ids sort as numbers do. */
export const padded = (index: number, width = 5): string =>
  String(index).padStart(width, '0');

const threadMessage = 'doric.storage.conformance.v1.Thread';

/** `Thread`'s indexes as `conformance.proto` declares them. */
export const threadIndexes: readonly IndexDeclaration[] = [
  { name: 'byProject', fields: ['projectId', 'createdAt'] },
  { name: 'byParent', fields: ['projectId', 'parentId'] },
  { name: 'byOwner', fields: ['owner.id'] },
  { name: 'byCount', fields: ['count'] },
  { name: 'byFlag', fields: ['flag'] },
  { name: 'byName', fields: ['name'] },
];

/** The conformance files with `Thread` declaring `indexes`. */
export const threadsWith = (indexes: readonly IndexDeclaration[]) =>
  conformanceFiles.map((file) =>
    file.messages.some((message) => message.typeName === threadMessage)
      ? withIndexes(file, threadMessage, indexes)
      : file,
  );
