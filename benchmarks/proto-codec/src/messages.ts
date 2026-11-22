import {
  type DescMessage,
  fromJson,
  type MessageShape,
  toBinary,
} from '@bufbuild/protobuf';
import { commitBatchSchema } from 'bundle/contracts';
import { type ThreadEvent, threadWatchItemSchema } from 'runtime/contracts';
import { encodeIndexKey } from 'storage';
import { z } from 'zod';

import {
  CommitRequestSchema,
  StreamEntryHeaderSchema,
  StreamHeadSchema,
} from '../dist/src/contracts/gen/doric/benchmarks/proto_codec/v1/kv_pb.js';
import { WatchThreadResponseSchema } from '../dist/src/contracts/gen/doric/benchmarks/proto_codec/v1/threads_pb.js';
import { ExecuteRequestSchema } from '../dist/src/contracts/gen/doric/benchmarks/proto_codec/v1/tools_pb.js';

/**
 * One benchmark case: today's value with today's zod schema, and the same
 * value as the messages of the `.proto` draft. A case whose wire form is a
 * stream (a KV commit) holds one message per stream item.
 */
export interface Case<Desc extends DescMessage = DescMessage> {
  readonly name: string;
  /** Today's value, as the envelope sends it with `v8.serialize`. */
  readonly today: unknown;
  /** Today's schema, which the receiving side parses with. */
  readonly zod: z.ZodType;
  readonly schema: Desc;
  readonly messages: readonly MessageShape<Desc>[];
}

const projectId = '5b0d7c8e-58f1-4a5e-9a3e-0f6f1d6f1a01';
const threadId = '7a3c1e2f-4b5d-4c6e-8f7a-9b0c1d2e3f40';
const at = (offset: number) =>
  new Date(Date.UTC(2026, 10, 21, 12, 0, 0) + offset * 1000).toISOString();

/** Text of a given length, varied so no compressor or interning helps. */
const text = (seed: number, length: number) => {
  const words = ['agent', 'tool', 'stream', 'router', 'bundle', 'thread'];
  let out = '';
  for (let index = 0; out.length < length; index += 1) {
    out += `${words[(seed + index) % words.length]}${(seed * 31 + index) % 97} `;
  }
  return out.slice(0, length);
};

/** The `event` of a Thread event: the shapes of today's agent events. */
const agentEvent = (sequence: number): unknown => {
  switch (sequence % 4) {
    case 0:
      return {
        type: 'text-delta',
        id: `t${sequence}`,
        delta: text(sequence, 160),
      };
    case 1:
      return {
        type: 'tool-call',
        toolCallId: `call_${sequence}`,
        toolName: 'read_file',
        input: {
          path: `src/file-${sequence}.ts`,
          offset: sequence,
          limit: 200,
        },
      };
    case 2:
      return {
        type: 'tool-result',
        toolCallId: `call_${sequence - 1}`,
        output: { type: 'text', value: text(sequence, 600) },
      };
    default:
      return {
        type: 'finish-step',
        usage: {
          inputTokens: 1200 + sequence,
          outputTokens: 80,
          totalTokens: 1280 + sequence,
        },
        finishReason: 'tool-calls',
      };
  }
};

const threadEvent = (sequence: number): ThreadEvent => ({
  projectId,
  threadId,
  promptId: `prompt-${Math.floor(sequence / 50)}`,
  sequence,
  type: 'agent:event',
  event: agentEvent(sequence),
  createdAt: at(sequence),
});

const project = {
  id: projectId,
  name: 'doric',
  state: 'ready' as const,
  configRevision: 3,
  createdAt: at(0),
  updatedAt: at(1),
};

const thread = {
  id: threadId,
  projectId,
  origin: 'user' as const,
  name: 'Benchmark the codec',
  state: 'ready' as const,
  lastSequence: 500,
  cwd: '/workspace/doric',
  cwdRepo: 'git' as const,
  createdAt: at(0),
  updatedAt: at(500),
  result: {
    status: 'completed',
    text: text(7, 400),
    promptId: 'prompt-9',
    at: at(500),
  },
  agent: { name: 'default', source: 'built-in' as const },
  model: 'claude-sonnet',
  effort: 'medium' as const,
  providerId: 'anthropic',
};

/** Splits a `kind`-discriminated value into its proto JSON form, `{ [kind]: rest }`. */
const oneofJson = ({ kind, ...rest }: { kind: string }) => ({ [kind]: rest });

const fromToday = <Desc extends DescMessage>(schema: Desc, json: unknown) =>
  fromJson(schema, json as Parameters<typeof fromJson>[1]);

/** A record's binary value, as the storage library writes it. */
const fromJsonBinary = <Desc extends DescMessage>(
  schema: Desc,
  json: unknown,
) => toBinary(schema, fromToday(schema, json));

/** Case 1: a `runtime.threads/v1.WatchThread` snapshot with 500 events. */
const threadSnapshot = (): Case => {
  const today = {
    kind: 'snapshot' as const,
    threadId,
    projectId,
    project,
    thread,
    events: Array.from({ length: 500 }, (_, index) => threadEvent(index + 1)),
  };
  return {
    name: 'Thread snapshot',
    today,
    zod: threadWatchItemSchema,
    schema: WatchThreadResponseSchema,
    messages: [fromToday(WatchThreadResponseSchema, oneofJson(today))],
  };
};

const utf8 = new TextEncoder();
const prefix = utf8.encode('runtime/');
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};
const key = (...tuple: (string | number)[]) =>
  concat(prefix, encodeIndexKey(tuple));
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

/**
 * Case 2: a `storage.kv/v1` commit of 100 appended events, with the layout's
 * records (spec, section 17, "The layout"): the head's condition, one
 * `stream.entry` per event with the event in its chunk, and the new head.
 * Today it is one `storage.backend/v1.commit` batch with one append.
 */
const storageCommit = (): Case => {
  const stream = `runtime.thread.events/${threadId}`;
  const events = Array.from({ length: 100 }, (_, index) =>
    threadEvent(401 + index),
  );
  const today = { append: [{ stream, expectedSequence: 400, events }] };
  const headKey = key('stream.head', stream);

  const items: unknown[] = [
    { condition: { key: base64(headKey), version: 4096 } },
  ];
  for (const event of events) {
    const value = utf8.encode(JSON.stringify(event));
    items.push({
      put: {
        key: base64(key('stream.entry', stream, event.sequence)),
        value: base64(
          fromJsonBinary(StreamEntryHeaderSchema, {
            createdAt: Date.parse(event.createdAt),
            valueSize: value.length,
            chunkCount: 0,
            chunk: base64(value),
          }),
        ),
      },
    });
  }
  items.push({
    put: {
      key: base64(headKey),
      value: base64(fromJsonBinary(StreamHeadSchema, { lastSequence: 500 })),
    },
  });

  return {
    name: 'Storage commit',
    today,
    zod: commitBatchSchema,
    schema: CommitRequestSchema,
    messages: items.map((item) => fromToday(CommitRequestSchema, item)),
  };
};

/** The tool payload's JSON: 64 KiB of nested objects, arrays and strings. */
const toolInput = () => {
  const files: unknown[] = [];
  for (let index = 0; JSON.stringify(files).length < 64 * 1024; index += 1) {
    files.push({
      path: `src/module-${index}/index.ts`,
      edits: [{ line: index, text: text(index, 180) }],
      dryRun: index % 2 === 0,
      size: 1000 + index,
    });
  }
  return { files };
};

/**
 * Case 3: a `doric.tools.v1.ExecuteRequest` with a 64 KiB JSON payload. Today
 * the payload crosses as `unknown` and the tool's own schema parses it; the
 * zod schema is the request's shape with an unknown input.
 */
const toolPayload = (): Case => {
  const today = { name: 'apply_edits', projectId, input: toolInput() };
  return {
    name: 'Tool payload',
    today,
    zod: z
      .object({
        name: z.string().min(1).max(128),
        projectId: z.string().optional(),
        input: z.unknown(),
      })
      .strict(),
    schema: ExecuteRequestSchema,
    messages: [fromToday(ExecuteRequestSchema, today)],
  };
};

/** The three cases of section 8's table. */
export const buildCases = (): readonly Case[] => [
  threadSnapshot(),
  storageCommit(),
  toolPayload(),
];
