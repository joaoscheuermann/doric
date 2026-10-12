import assert from 'node:assert/strict';

import type { StorageBackend } from 'bundle/contracts';

import { caseGroup } from './harness.js';
import {
  feedAfter,
  isCode,
  lastPosition,
  normalized,
  open,
  sortedKeys,
} from './support.js';

const note = 'conformance.note/v1';
const key = (id: string) => ({ type: note, id });
const put = (id: string, value: unknown) => ({ type: note, id, value });
const stream = 'conformance.note.events/n1';
const second = 'conformance.note.events/n2';

const positions = async (backend: StorageBackend, after: number) =>
  (await feedAfter(backend, after)).map(({ position }) => position);

const assertIncreasing = (values: readonly number[]) => {
  for (let index = 1; index < values.length; index += 1) {
    assert.ok(
      (values[index] as number) > (values[index - 1] as number),
      `positions increase: ${values.join(', ')}`,
    );
  }
};

const feeds = caseGroup('feed');

export const feedCases = [
  feeds(
    'F1',
    'positions strictly increase, and a reader tailing concurrent commits misses none',
    async (harness) => {
      const backend = await open(harness);
      const start = await lastPosition(backend);
      const sequential: number[] = [];

      for (let index = 0; index < 5; index += 1) {
        sequential.push(
          (await backend.commit({ put: [put(`s${index}`, index)] })).position,
        );
      }

      assert.ok((sequential[0] as number) > start);
      assertIncreasing(sequential);
      assert.deepEqual(await positions(backend, start), sequential);

      const writers = [
        await open(harness),
        await open(harness),
        await open(harness),
      ];
      const reader = await open(harness);
      const from = await lastPosition(reader);
      const seen: number[] = [];
      let done = false;
      // A position that becomes visible only after a later one would be
      // skipped by this reader, which always continues after the last it saw.
      const tail = (async () => {
        let after = from;

        for (;;) {
          const finished = done;
          const page = await reader.feed({ after, limit: 7 });

          for (const { position } of page.commits) {
            assert.ok(position > after, 'a page continues after its cursor');
            seen.push(position);
            after = position;
          }

          if (finished && page.commits.length === 0) {
            return;
          }

          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      let committed: number[] = [];

      try {
        committed = (
          await Promise.all(
            Array.from({ length: 40 }, (_, index) =>
              (writers[index % 3] as StorageBackend).commit({
                put: [put(`c${index}`, index)],
              }),
            ),
          )
        ).map(({ position }) => position);
      } finally {
        done = true;
        await tail;
      }

      assert.equal(
        new Set(committed).size,
        40,
        'every commit has its own position',
      );
      assert.deepEqual(
        seen,
        [...committed].sort((left, right) => left - right),
      );
    },
  ),
  feeds(
    'F2',
    'each successful commit appears once, in commit order, with what it touched',
    async (harness) => {
      const backend = await open(harness);
      const start = await lastPosition(backend);

      const first = await backend.commit({
        put: [put('n1', 1), put('n1', 2), put('n2', 1)],
        append: [
          { stream, events: ['a', 'b'] },
          { stream, events: ['c'] },
        ],
      });
      const removal = await backend.commit({
        delete: [key('n1'), key('absent')],
        truncate: { stream, afterSequence: 1 },
        dropStreams: [second, second],
      });
      const mixed = await backend.commit({
        delete: [key('n2')],
        put: [put('n2', 'again'), put('n3', 'new')],
        truncate: { stream, afterSequence: 1 },
        append: [
          { stream, events: ['d'] },
          { stream: second, events: ['e'] },
        ],
      });
      // A batch of expectations alone is a commit that touches nothing.
      const check = await backend.commit({
        expect: [{ ...key('n3'), revision: 1 }],
      });

      assert.deepEqual((await feedAfter(backend, start)).map(normalized), [
        {
          position: first.position,
          documents: sortedKeys([key('n1'), key('n2')]),
          streams: [stream],
          truncated: [],
          dropped: [],
        },
        {
          position: removal.position,
          documents: sortedKeys([key('n1'), key('absent')]),
          streams: [],
          truncated: [stream],
          dropped: [second],
        },
        {
          position: mixed.position,
          documents: sortedKeys([key('n2'), key('n3')]),
          streams: [second, stream].sort(),
          truncated: [stream],
          dropped: [],
        },
        {
          position: check.position,
          documents: [],
          streams: [],
          truncated: [],
          dropped: [],
        },
      ]);

      // A page holds at most its limit and continues after its cursor.
      const page = await backend.feed({ after: first.position, limit: 2 });

      assert.deepEqual(
        page.commits.map(({ position }) => position),
        [removal.position, mixed.position],
      );
      assert.deepEqual(
        await backend.feed({ after: check.position, limit: 10 }),
        { commits: [] },
      );
    },
  ),
  feeds('F3', 'a failed commit leaves no feed entry', async (harness) => {
    const backend = await open(harness, { limits: { maxBatch: 3 } });

    await backend.declareType({
      type: note,
      indexes: [{ name: 'byTitle', fields: ['title'], unique: true }],
    });

    const start = await lastPosition(backend);
    const succeeded: number[] = [];
    const failures: [string, Parameters<StorageBackend['commit']>[0]][] = [
      ['revision_conflict', { expect: [{ ...key('n1'), revision: 4 }] }],
      [
        'sequence_conflict',
        { append: [{ stream, expectedSequence: 9, events: ['x'] }] },
      ],
      ['unique_conflict', { put: [put('n2', { title: 'taken' })] }],
      [
        'limit_exceeded',
        { append: [{ stream, events: ['1', '2', '3', '4'] }] },
      ],
      ['invalid_input', {}],
      ['invalid_input', { truncate: { stream, afterSequence: 50 } }],
    ];

    succeeded.push(
      (await backend.commit({ put: [put('n1', { title: 'taken' })] })).position,
    );

    for (const [index, [code, batch]] of failures.entries()) {
      await assert.rejects(backend.commit(batch), isCode(code));
      succeeded.push(
        (await backend.commit({ append: [{ stream, events: [index] }] }))
          .position,
      );
    }

    assert.deepEqual(await positions(backend, start), succeeded);
  }),
  feeds(
    'F4',
    'after a crash, a new instance continues the feed exactly where it was read',
    async (harness) => {
      const crashed = await harness.open();
      const start = await lastPosition(crashed.backend);
      const committed: number[] = [];

      for (let index = 0; index < 6; index += 1) {
        committed.push(
          (
            await crashed.backend.commit({
              put: [put(`n${index}`, index)],
              append: [{ stream, events: [index] }],
            })
          ).position,
        );
      }

      const read = await crashed.backend.feed({ after: start, limit: 4 });

      assert.deepEqual(
        read.commits.map(({ position }) => position),
        committed.slice(0, 4),
      );

      const resumeAfter = read.commits.at(-1)?.position ?? start;

      await harness.crash(crashed);

      const reopened = await open(harness);

      assert.deepEqual(
        await positions(reopened, resumeAfter),
        committed.slice(4),
      );
      // Everything committed before the crash is there.
      assert.deepEqual(await reopened.get(key('n5')), {
        ...key('n5'),
        revision: 1,
        value: 5,
      });
      assert.equal(
        (await reopened.read({ stream, afterSequence: 0, limit: 1 }))
          .lastSequence,
        6,
      );

      const next = await reopened.commit({
        append: [{ stream, events: ['after'] }],
      });

      assert.ok(next.position > (committed.at(-1) as number));
      assert.deepEqual(await positions(reopened, resumeAfter), [
        ...committed.slice(4),
        next.position,
      ]);
    },
  ),
];
