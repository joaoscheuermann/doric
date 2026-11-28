/**
 * Query pages over `storage/v2` (T4.3, T4.9, A39): Q5's walk of every
 * limit, Q6's writes between pages, and T4.9's ten matches at `limit: 3`.
 * `indexes.ts` runs them after Q1–Q4.
 */
import assert from 'node:assert/strict';

import type { StoragePage, StorageQuery } from '../../client/types.js';
import { thread, threadKey, threadPut } from './fixtures.js';
import { caseGroup, type V2Case } from './harness.js';
import { ids, isCode, walk } from './support.js';

const queries = caseGroup('paginated queries');

const byProject = (
  extra: Partial<StorageQuery> = {},
): Omit<StorageQuery, 'limit'> & Partial<StorageQuery> => ({
  type: thread,
  index: 'byProject',
  equals: ['p1'],
  ...extra,
});

/** Every page holds `limit` documents but the last, which alone ends the list. */
const assertPaged = (pages: readonly StoragePage[], limit: number): void => {
  assert.ok(pages.length > 0, 'at least one page');
  pages.forEach((page, index) => {
    const last = index === pages.length - 1;

    assert.equal(page.nextCursor === null, last, `page ${index} ends the list`);
    if (!last) {
      assert.equal(page.items.length, limit, `page ${index} is full`);
    }
  });
};

const flat = (pages: readonly StoragePage[]): string[] => pages.flatMap(ids);

/** The cases, in run order: Q5, Q6, T4.9. None is skipped. */
export const pagingCases: readonly V2Case[] = [
  queries(
    'Q5',
    'pages of every limit walk each item exactly once, in both orders',
    async (harness) => {
      const storage = await harness.open();

      await storage.commit({
        put: Array.from({ length: 9 }, (_, index) =>
          threadPut(`t${index}`, {
            projectId: 'p1',
            // Two items share each day, so pages also split ties.
            createdAt: `day-${Math.floor(index / 2)}`,
          }),
        ),
      });

      const all = Array.from({ length: 9 }, (_, index) => `t${index}`);

      for (let limit = 1; limit <= 10; limit += 1) {
        const asc = await walk(storage, { ...byProject(), limit });
        const desc = await walk(storage, {
          ...byProject({ order: 'desc' }),
          limit,
        });

        assertPaged(asc, limit);
        assertPaged(desc, limit);
        assert.deepEqual(flat(asc), all, `asc ${limit}`);
        assert.deepEqual(flat(desc), [...all].reverse(), `desc ${limit}`);
      }

      // A page that reaches the end has no cursor; a malformed one is refused.
      const whole = await storage.query({ ...byProject(), limit: 9 });

      assert.deepEqual(ids(whole), all);
      assert.equal(whole.nextCursor, null);
      await assert.rejects(
        storage.query({ ...byProject(), limit: 1, cursor: 'not a cursor' }),
        isCode('invalid_input'),
      );
    },
  ),
  queries(
    'Q6',
    'a document committed between pages after the cursor is read once, and none behind it is repeated',
    async (harness) => {
      const reader = await harness.open();
      const writer = await harness.open();

      await reader.commit({
        put: ['b', 'd', 'f', 'h', 'j'].map((day) =>
          threadPut(day, { projectId: 'p1', createdAt: day }),
        ),
      });

      const first = await reader.query({ ...byProject(), limit: 2 });

      assert.deepEqual(ids(first), ['b', 'd']);
      assert.ok(first.nextCursor !== null, 'the first page has a cursor');

      // Behind the cursor, ahead of it, a move from ahead to behind, and a delete.
      await writer.commit({
        put: [
          threadPut('a', { projectId: 'p1', createdAt: 'a' }),
          threadPut('e', { projectId: 'p1', createdAt: 'e' }),
          threadPut('f', { projectId: 'p1', createdAt: 'c' }),
          threadPut('elsewhere', { projectId: 'p2', createdAt: 'e' }),
        ],
        delete: [threadKey('h')],
      });

      const second = await reader.query({
        ...byProject(),
        limit: 1,
        cursor: first.nextCursor,
      });

      assert.deepEqual(ids(second), ['e']);
      assert.ok(second.nextCursor !== null, 'j is still ahead');

      // The document a cursor ended on may itself be gone.
      await writer.commit({ delete: [threadKey('e')] });

      const rest = await walk(reader, {
        ...byProject(),
        limit: 10,
        cursor: second.nextCursor,
      });

      assert.deepEqual(flat(rest), ['j']);
      assert.deepEqual(
        [...ids(first), ...ids(second), ...flat(rest)],
        ['b', 'd', 'e', 'j'],
      );
    },
  ),
  queries(
    'T4.9',
    'ten matches read with limit 3 come in pages of 3, 3, 3 and 1, and only the fourth ends the list',
    async (harness) => {
      const storage = await harness.open();
      const matching = Array.from({ length: 10 }, (_, index) => `m${index}`);

      await storage.commit({
        put: [
          ...[...matching]
            .reverse()
            .map((id) => threadPut(id, { projectId: 'p1', createdAt: id })),
          threadPut('other', { projectId: 'p2', createdAt: 'm5' }),
        ],
      });

      const pages = await walk(storage, { ...byProject(), limit: 3 });

      assert.deepEqual(
        pages.map((page) => page.items.length),
        [3, 3, 3, 1],
      );
      assert.deepEqual(
        pages.map((page) => page.nextCursor === null),
        [false, false, false, true],
      );
      assert.deepEqual(flat(pages), matching);
    },
  ),
];
