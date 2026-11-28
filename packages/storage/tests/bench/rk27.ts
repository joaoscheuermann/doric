// RK27's write-stall measurements (spec `docs/designs/grpc-processes.md`,
// "Risks", RK27; AC4.25): the longest write transactions of the `sqlite`
// engine, measured on its release build. Not a test: `tsconfig.spec.json`
// compiles it into `dist-tests` and `nx run storage:bench-rk27` runs it with
// node. It only reports; it exits 1 only when something throws.
//
// - (b), three runs, judged by the slowest: one `Commit` of 10,000 `Note`
//   puts whose values total 67,108,864 bytes, the most one batch holds.
// - (a), one run: the backfill of a new non-unique index `byTagTitle[tag,
//   title]` over 100,000 `Note`s of 1,024 bytes each, written in 10
//   commits of 10,000: the rebuild limit since S77c2 (S77c first measured
//   200,000, 9,876 ms).
//
// S87 adds measurement (c), an `Import` of the same size.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { availableParallelism, cpus } from 'node:os';
import { performance } from 'node:perf_hooks';

import { create, toBinary } from '@bufbuild/protobuf';
import type { CallOptions } from 'bundle/contracts';

import type { DocumentPut, Storage } from '../../src/client/types.js';
import { note, padded } from '../../src/conformance/v2/fixtures.js';
import {
  conformanceBundle,
  conformanceFiles,
} from '../../src/conformance/v2/harness.js';
import {
  type IndexDeclaration,
  withIndexes,
} from '../../src/conformance/v2/support.js';
import {
  type Note,
  NoteSchema,
} from '../../src/contracts/gen/doric/storage/conformance/v1/conformance_pb.js';
import { openTestEngineAt, testEngineBinary } from '../../src/test-engine.js';

const noteMessage = 'doric.storage.conformance.v1.Note';

/** `Note`'s indexes as `conformance.proto` declares them. */
const noteIndexes: readonly IndexDeclaration[] = [
  { name: 'byTitle', fields: ['title'], unique: true },
  { name: 'byTag', fields: ['tag'] },
];

const batchItems = 10_000;
const batchBytes = 67_108_864;
const backfillDocuments = 100_000;
const backfillDocumentBytes = 1_024;
const tags = 100;
const stallMs = 5_000;

/** A call that ends 30 s from now, the client's longest deadline. */
const call = (): CallOptions => ({ deadline: Date.now() + 30_000 });

/** The bytes of a protobuf varint of `value`. */
const varintBytes = (value: number): number => {
  let bytes = 1;

  for (let rest = value; rest >= 0x80; rest = Math.floor(rest / 0x80)) {
    bytes += 1;
  }

  return bytes;
};

/**
 * A `Note` titled `title`, tagged `tag`, whose binary value is exactly
 * `bytes` long, the rest being `body` (its tag byte, its length's varint and
 * a repeating pattern).
 */
const noteOf = (title: string, tag: string, bytes: number): Note => {
  const head = toBinary(NoteSchema, create(NoteSchema, { title, tag })).length;
  let length = bytes - head - 2;

  while (head + 1 + varintBytes(length) + length > bytes) {
    length -= 1;
  }

  const value = create(NoteSchema, {
    title,
    tag,
    body: new Uint8Array(length).map((_, index) => index % 251),
  });

  assert.equal(toBinary(NoteSchema, value).length, bytes, 'the value size');

  return value;
};

/** The put of the `index`th note, `bytes` long. */
const putOf = (index: number, bytes: number): DocumentPut => ({
  type: note,
  id: padded(index, 6),
  value: noteOf(`note-${padded(index, 6)}`, `tag-${index % tags}`, bytes),
});

/** (b)'s batch: 10,000 puts whose values total exactly 67,108,864 bytes. */
const batchPuts = (): DocumentPut[] => {
  const base = Math.floor(batchBytes / batchItems);
  const larger = batchBytes - base * batchItems;
  const puts = Array.from({ length: batchItems }, (_, index) =>
    putOf(index, index < larger ? base + 1 : base),
  );
  const total = puts.reduce(
    (sum, put) => sum + toBinary(NoteSchema, put.value as Note).length,
    0,
  );

  assert.equal(total, batchBytes, "the batch's value bytes");

  return puts;
};

const print = (line: Record<string, unknown>): void => {
  process.stdout.write(`${JSON.stringify(line)}\n`);
};

const main = async (): Promise<void> => {
  const binary = testEngineBinary('release');

  if (!existsSync(binary)) {
    throw new Error(
      'doric-sqlite (release) is not built: run npx nx run sqlite:compile:production',
    );
  }

  const engine = await openTestEngineAt(binary);

  try {
    print({
      measurement: 'rk27.environment',
      node: process.versions.node,
      cpu: cpus()[0]?.model ?? 'unknown',
      cpus: availableParallelism(),
      binary,
      profile: 'release',
    });

    const puts = batchPuts();
    const commits: number[] = [];

    for (let run = 1; run <= 3; run += 1) {
      await engine.reset();

      const storage: Storage = await engine.storage(
        conformanceBundle,
        conformanceFiles,
      );
      const start = performance.now();

      await storage.commit({ put: puts }, call());

      const ms = performance.now() - start;

      commits.push(ms);
      print({
        measurement: 'rk27.b',
        run,
        items: batchItems,
        bytes: batchBytes,
        ms,
      });
    }

    await engine.reset();

    const before = await engine.storage(conformanceBundle, conformanceFiles);

    for (let first = 0; first < backfillDocuments; first += batchItems) {
      await before.commit(
        {
          put: Array.from({ length: batchItems }, (_, offset) =>
            putOf(first + offset, backfillDocumentBytes),
          ),
        },
        call(),
      );
    }

    const files = conformanceFiles.map((file) =>
      file.messages.some((message) => message.typeName === noteMessage)
        ? withIndexes(file, noteMessage, [
            ...noteIndexes,
            { name: 'byTagTitle', fields: ['tag', 'title'] },
          ])
        : file,
    );
    const start = performance.now();
    const after = await engine.storage(conformanceBundle, files);
    const ms = performance.now() - start;
    const page = await after.query(
      { type: note, index: 'byTagTitle', equals: ['tag-0'], limit: 1 },
      call(),
    );

    assert.equal(page.items.length, 1, 'the documents byTagTitle answers');

    const documentsPerSecond = (backfillDocuments * 1000) / ms;

    print({
      measurement: 'rk27.a',
      documents: backfillDocuments,
      documentBytes: backfillDocumentBytes,
      ms,
      documentsPerSecond,
    });
    print({
      measurement: 'rk27.rule',
      backfillWithin5s: ms <= stallMs,
      ...(ms > stallMs
        ? {
            rebuildLimit:
              Math.floor((documentsPerSecond * stallMs) / 1000 / 10_000) *
              10_000,
          }
        : {}),
      commitOver5s: Math.max(...commits) > stallMs,
    });
  } finally {
    await engine.close();
  }
};

main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    process.stderr.write(
      `RK27 failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  },
);
