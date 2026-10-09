import assert from 'node:assert/strict';
import test from 'node:test';

import type { CommitBatch, StorageBackend } from 'bundle/contracts';

import {
  type ConformanceCase,
  conformanceCases,
  runConformanceCase,
} from '../src/conformance/index.js';
import type { MemoryStore } from '../src/memory/index.js';
import { memoryHarness } from './support/memory-harness.js';

// The kit detects broken backends (stage-3 evidence): each deliberately
// broken variant of the memory backend fails the cases that guard the
// behavior it breaks, while a pass-through wrapper passes them.

/** A backend that forwards every call unchanged. */
const forward = (backend: StorageBackend): StorageBackend => ({
  declareType: (declaration) => backend.declareType(declaration),
  get: (key) => backend.get(key),
  query: (query) => backend.query(query),
  read: (request) => backend.read(request),
  commit: (batch) => backend.commit(batch),
  feed: (request) => backend.feed(request),
  putBlob: (bytes) => backend.putBlob(bytes),
  getBlob: (hash) => backend.getBlob(hash),
  capabilities: () => backend.capabilities(),
  health: () => backend.health(),
  identity: () => backend.identity(),
});

/**
 * No atomicity: every write of a batch is its own commit, and the
 * expectations are checked after the writes.
 */
const nonAtomic = (backend: StorageBackend): StorageBackend => ({
  ...forward(backend),
  commit: async (batch) => {
    const parts: CommitBatch[] = [
      ...(batch.delete?.length ? [{ delete: batch.delete }] : []),
      ...(batch.put ?? []).map((put) => ({ put: [put] })),
      ...(batch.dropStreams?.length
        ? [{ dropStreams: batch.dropStreams }]
        : []),
      ...(batch.truncate === undefined ? [] : [{ truncate: batch.truncate }]),
      ...(batch.append ?? []).flatMap(({ stream, expectedSequence, events }) =>
        events.map((event, index) => ({
          append: [
            {
              stream,
              ...(index === 0 && expectedSequence !== undefined
                ? { expectedSequence }
                : {}),
              events: [event],
            },
          ],
        })),
      ),
      ...(batch.expect?.length ? [{ expect: batch.expect }] : []),
    ];
    let result = { position: 0 };

    if (parts.length === 0) {
      return backend.commit(batch);
    }

    for (const part of parts) {
      result = await backend.commit(part);
    }

    return result;
  },
});

/**
 * Reuses sequences: after a truncation the counter falls back to the last
 * entry left, so the next append takes a number a reader may already hold.
 */
const reusedSequences = (
  backend: StorageBackend,
  store: MemoryStore,
): StorageBackend => ({
  ...forward(backend),
  commit: async (batch) => {
    const result = await backend.commit(batch);
    const truncated =
      batch.truncate === undefined
        ? undefined
        : store.streams.get(batch.truncate.stream);

    if (truncated !== undefined) {
      truncated.lastSequence = truncated.entries.at(-1)?.sequence ?? 0;
    }

    return result;
  },
});

/** A feed gap: every third commit never shows up in the feed. */
const feedGap = (backend: StorageBackend): StorageBackend => ({
  ...forward(backend),
  feed: async (request) => {
    const page = await backend.feed(request);

    return {
      commits: page.commits.filter(({ position }) => position % 3 !== 0),
    };
  },
});

const cases = (...ids: string[]): ConformanceCase[] =>
  ids.map((id) => {
    const found = conformanceCases.find((entry) => entry.id === id);

    assert.ok(found !== undefined, `case ${id} exists`);

    return found;
  });

/** The cases of `targets` that fail against the harness, by ID. */
const failing = async (
  harness: ReturnType<typeof memoryHarness>,
  targets: readonly ConformanceCase[],
): Promise<string[]> => {
  const failed: string[] = [];

  for (const target of targets) {
    try {
      await runConformanceCase(harness, target);
    } catch {
      // A failed assertion or an error the case did not expect: either way
      // the variant does not conform.
      failed.push(target.id);
    }
  }

  return failed;
};

const variants = [
  {
    name: 'no atomicity',
    wrap: nonAtomic,
    targets: cases('X1', 'X2', 'X3', 'X4'),
  },
  {
    name: 'reused sequences',
    wrap: reusedSequences,
    targets: cases('S3', 'S4'),
  },
  {
    name: 'a feed gap',
    wrap: feedGap,
    targets: cases('F1', 'F2', 'F3', 'F4'),
  },
] as const;

for (const variant of variants) {
  const ids = variant.targets.map(({ id }) => id);

  void test(`the kit fails a backend with ${variant.name} in ${ids.join(', ')}`, async () => {
    assert.deepEqual(
      await failing(
        memoryHarness({ name: variant.name, wrap: variant.wrap }),
        variant.targets,
      ),
      ids,
    );
  });
}

void test('a pass-through wrapper of the memory backend passes the same cases', async () => {
  assert.deepEqual(
    await failing(
      memoryHarness({ name: 'forwarded', wrap: forward }),
      variants.flatMap(({ targets }) => targets),
    ),
    [],
  );
});

void test('case IDs are unique and every group of the design is covered', () => {
  const ids = conformanceCases.map(({ id }) => id);

  assert.equal(new Set(ids).size, ids.length);

  const numbered = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`);

  // The design's case list, group by group.
  const expected = [
    ...numbered('D', 7),
    ...numbered('C', 4),
    ...numbered('R', 3),
    ...numbered('Q', 10),
    ...numbered('S', 6),
    ...numbered('P', 2),
    ...numbered('F', 4),
    ...numbered('X', 5),
    ...numbered('B', 3),
    ...numbered('L', 3),
    ...numbered('H', 2),
  ];

  assert.deepEqual(ids, expected);
});
