import assert from 'node:assert/strict';

import {
  type FeedPage,
  isContractError,
  type StorageBackend,
  type StorageQuery,
  type StreamEntry,
} from 'bundle/contracts';

import type { ConformanceHarness, ConformanceOpenOptions } from './harness.js';

export type Commit = FeedPage['commits'][number];

/** Opens an instance and returns its backend; the runner closes it. */
export const open = async (
  harness: ConformanceHarness,
  options?: ConformanceOpenOptions,
): Promise<StorageBackend> => (await harness.open(options)).backend;

/** An `assert.rejects` matcher for a ContractError code (and its details). */
export const isCode =
  (code: string, details?: unknown) =>
  (error: unknown): boolean => {
    assert.ok(isContractError(error), `expected ${code}, got ${String(error)}`);
    assert.equal(error.code, code, error.message);

    if (details !== undefined) {
      assert.deepEqual(error.details, details);
    }

    return true;
  };

/** `ok`, the ContractError code of a rejection, or its text, for counting outcomes. */
export const codeOf = (result: PromiseSettledResult<unknown>): string =>
  result.status === 'fulfilled'
    ? 'ok'
    : isContractError(result.reason)
      ? result.reason.code
      : String(result.reason);

/** How many outcomes carry each code. */
export const tally = (
  results: readonly PromiseSettledResult<unknown>[],
): Record<string, number> => {
  const counts: Record<string, number> = {};

  for (const result of results) {
    const code = codeOf(result);

    counts[code] = (counts[code] ?? 0) + 1;
  }

  return counts;
};

/** Every commit after `after`, read page by page. */
export const feedAfter = async (
  backend: StorageBackend,
  after = 0,
): Promise<Commit[]> => {
  const commits: Commit[] = [];
  let position = after;

  for (;;) {
    const page = await backend.feed({ after: position, limit: 100 });
    const last = page.commits.at(-1);

    if (last === undefined) {
      return commits;
    }

    commits.push(...page.commits);
    position = last.position;
  }
};

/** The position of the newest commit in the feed, or 0. */
export const lastPosition = async (backend: StorageBackend): Promise<number> =>
  (await feedAfter(backend)).at(-1)?.position ?? 0;

/** The IDs of one query page, in page order. */
export const queryIds = async (
  backend: StorageBackend,
  query: StorageQuery,
): Promise<string[]> => (await backend.query(query)).items.map(({ id }) => id);

/** Walks every page of a query with this limit and returns the IDs in order. */
export const walk = async (
  backend: StorageBackend,
  query: Omit<StorageQuery, 'limit' | 'cursor'>,
  limit: number,
): Promise<string[]> => {
  const seen: string[] = [];
  let cursor: string | undefined;

  do {
    const page = await backend.query({
      ...query,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    });

    assert.ok(page.items.length <= limit, `a page holds at most ${limit}`);
    seen.push(...page.items.map(({ id }) => id));
    cursor = page.cursor;
  } while (cursor !== undefined);

  return seen;
};

/** Every entry of a stream after `afterSequence`, read page by page. */
export const readAfter = async (
  backend: StorageBackend,
  stream: string,
  afterSequence = 0,
  limit = 100,
): Promise<StreamEntry[]> => {
  const entries: StreamEntry[] = [];
  let after = afterSequence;

  for (;;) {
    const page = await backend.read({ stream, afterSequence: after, limit });
    const last = page.entries.at(-1);

    if (last === undefined) {
      return entries;
    }

    entries.push(...page.entries);
    after = last.sequence;
  }
};

/** `[sequence, value]` pairs of a stream after `afterSequence`. */
export const sequenced = async (
  backend: StorageBackend,
  stream: string,
  afterSequence = 0,
): Promise<[number, unknown][]> =>
  (await readAfter(backend, stream, afterSequence)).map(
    ({ sequence, value }) => [sequence, value],
  );

/** Integers from 1 to `count`. */
export const upTo = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index + 1);

/** Sorts document keys so a comparison ignores their order inside one commit. */
export const sortedKeys = (
  keys: readonly { readonly type: string; readonly id: string }[],
): { type: string; id: string }[] =>
  keys
    .map(({ type, id }) => ({ type, id }))
    .sort((left, right) =>
      `${left.type}/${left.id}` < `${right.type}/${right.id}` ? -1 : 1,
    );

/** A feed commit with the order inside each list ignored. */
export const normalized = (commit: Commit) => ({
  position: commit.position,
  documents: sortedKeys(commit.documents),
  streams: [...commit.streams].sort(),
  truncated: [...commit.truncated].sort(),
  dropped: [...commit.dropped].sort(),
});
