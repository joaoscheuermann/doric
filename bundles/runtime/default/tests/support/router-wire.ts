// The wire forms the routed harness reads and writes (phase 3, slice S51d):
// the executor's Thread and sources, the session's chunked JSON and `Value`s.

import {
  create,
  type JsonValue,
  type MessageInitShape,
  type MessageShape,
  toJson,
} from '@bufbuild/protobuf';
import { type Value, ValueSchema } from '@bufbuild/protobuf/wkt';
import type { HistoryPatch, InputSource } from 'runtime/contracts';
import type { RecordRequestSchema } from 'runtime/contracts/gen/doric/executor/session/v1/session_pb.js';
import {
  type CheckpointResponseSchema,
  ExecutorThreadSchema,
} from 'runtime/contracts/gen/doric/executor/v1/executor_pb.js';
import type { InputSourceSchema } from 'runtime/contracts/gen/doric/runtime/v2/runtime_pb.js';

import { projectId, threadId } from './harness.js';
import type { RecordedWrite, ThreadOverrides } from './router.js';

/** The plain JSON of a value: what crosses a wire or a log. */
export const plain = (value: unknown): unknown =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/** The Thread of every run, as the kernel harness's `thread()` holds it. */
export const wireThread = (overrides: ThreadOverrides = {}) =>
  create(ExecutorThreadSchema, {
    id: threadId,
    projectId,
    name: 'Main thread',
    state: 'running',
    lastSequence: 0,
    cwd: '/workspace',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  });

/** An `InputSource` as the wire carries it (user, terminal and bundle sources). */
export const wireSource = (
  source: InputSource,
): MessageInitShape<typeof InputSourceSchema> => {
  switch (source.kind) {
    case 'user':
      return { kind: { case: 'user', value: {} } };
    case 'terminal':
      return {
        kind: {
          case: 'terminal',
          value: { terminalId: source.terminalId, promptId: source.promptId },
        },
      };
    case 'bundle':
      return {
        kind: {
          case: 'bundle',
          value: {
            bundleId: source.bundleId,
            reason: source.reason,
            ...(source.retain === true ? { retain: true } : {}),
          },
        },
      };
    default:
      throw new Error(`No wire form for the ${source.kind} source here.`);
  }
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One value's UTF-8 JSON text as chunks of at most 1 MiB. */
export const chunksOf = (value: unknown): Uint8Array[] => {
  const bytes = encoder.encode(JSON.stringify(value));
  const chunks: Uint8Array[] = [];

  for (let at = 0; at < bytes.length; at += 1024 * 1024) {
    chunks.push(bytes.subarray(at, at + 1024 * 1024));
  }

  return chunks;
};

const joined = (chunks: readonly Uint8Array[]): unknown => {
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }

  return JSON.parse(decoder.decode(bytes));
};

export type RecordItem = MessageShape<typeof RecordRequestSchema>['item'];

/** A `Record` stream's items as the write it carries. */
export const writeOf = (items: readonly RecordItem[]): RecordedWrite => {
  let format: string | undefined;
  const parts: Record<string, unknown> = {};
  let part: string | undefined;
  let chunks: Uint8Array[] = [];
  let event: unknown;
  const flush = () => {
    if (part !== undefined) parts[part] = joined(chunks);
    part = undefined;
    chunks = [];
  };

  for (const item of items) {
    if (item.case === 'head') {
      format = item.value.format;
    } else if (item.case === 'part') {
      flush();
      part = item.value;
    } else if (item.case === 'chunk') {
      chunks.push(item.value);
    } else if (item.case === 'event') {
      flush();
      event = item.value;
    }
  }

  flush();

  return {
    ...(format === undefined ? {} : { history: { format, parts } }),
    ...(event === undefined ? {} : { event }),
  };
};

type CheckpointItem = MessageShape<typeof CheckpointResponseSchema>['item'];

/** A `Checkpoint` or `Rewind` stream read back as the patch it carries; `undefined` for no item. */
export const patchOf = async (
  stream: AsyncIterable<{ readonly item: CheckpointItem }>,
): Promise<HistoryPatch | undefined> => {
  let format: string | undefined;
  const parts: Record<string, unknown> = {};
  let part: string | undefined;
  let chunks: Uint8Array[] = [];
  const flush = () => {
    if (part !== undefined) parts[part] = joined(chunks);
    part = undefined;
    chunks = [];
  };

  for await (const { item } of stream) {
    if (item.case === 'format') format = item.value;
    else if (item.case === 'part') {
      flush();
      part = item.value;
    } else if (item.case === 'chunk') chunks.push(item.value);
  }

  flush();

  return format === undefined ? undefined : { format, parts };
};

/** A `google.protobuf.Value` field as JSON; `null` when absent. */
export const jsonOf = (value: Value | undefined): JsonValue =>
  value === undefined ? null : toJson(ValueSchema, value);

export async function* itemsOf<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield item;
  }
}
