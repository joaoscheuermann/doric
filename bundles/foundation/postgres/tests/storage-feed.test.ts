import assert from 'node:assert/strict';

import { isCode, storageTest } from './support/storage.js';

// The commit feed (stage-3 evidence: feed after crash), blobs and the
// storage identity of `storage.backend/v1` on PostgreSQL.

const note = 'test.note/v1';
const stream = 'test.note.events/n1';

storageTest(
  'the feed lists each successful commit once, in order, with what it touched',
  async ({ open }) => {
    const backend = open();

    const first = await backend.commit({
      put: [
        { type: note, id: 'n1', value: 1 },
        { type: note, id: 'n1', value: 2 },
      ],
      append: [{ stream, events: ['a', 'b'] }],
    });
    await assert.rejects(
      backend.commit({ expect: [{ type: note, id: 'n1', revision: 7 }] }),
      isCode('revision_conflict'),
    );
    const second = await backend.commit({
      delete: [{ type: note, id: 'n1' }],
      truncate: { stream, afterSequence: 1 },
      dropStreams: ['test.note.events/n2', 'test.note.events/n2'],
    });
    // A batch of expectations alone is a commit too.
    await backend.commit({ put: [{ type: note, id: 'n2', value: 0 }] });
    const third = await backend.commit({
      expect: [{ type: note, id: 'n2', revision: 1 }],
    });

    assert.deepEqual(
      [first, second, third].map(({ position }) => position),
      [1, 2, 4],
    );
    assert.deepEqual(await backend.feed({ after: 0, limit: 10 }), {
      commits: [
        {
          position: 1,
          documents: [{ type: note, id: 'n1' }],
          streams: [stream],
          truncated: [],
          dropped: [],
        },
        {
          position: 2,
          documents: [{ type: note, id: 'n1' }],
          streams: [],
          truncated: [stream],
          dropped: ['test.note.events/n2'],
        },
        {
          position: 3,
          documents: [{ type: note, id: 'n2' }],
          streams: [],
          truncated: [],
          dropped: [],
        },
        {
          position: 4,
          documents: [],
          streams: [],
          truncated: [],
          dropped: [],
        },
      ],
    });
    assert.deepEqual(
      (await backend.feed({ after: 1, limit: 2 })).commits.map(
        ({ position }) => position,
      ),
      [2, 3],
    );
  },
);

storageTest(
  'concurrent commits take gapless positions, visible in commit order',
  async ({ open }) => {
    const writers = [open(), open(), open()];
    const reader = open();
    const seen: number[] = [];
    let done = false;
    // A reader tailing the feed while commits land never sees a position
    // that a later page fills in behind it.
    const tail = (async () => {
      let after = 0;

      for (;;) {
        const finished = done;
        const page = await reader.feed({ after, limit: 7 });

        for (const { position } of page.commits) {
          assert.equal(position, after + 1);
          seen.push(position);
          after = position;
        }

        if (finished && page.commits.length === 0) {
          return;
        }
      }
    })();

    try {
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          writers[index % 3]?.commit({
            put: [{ type: note, id: `n${index}`, value: index }],
          }),
        ),
      );
    } finally {
      done = true;
      await tail;
    }

    assert.deepEqual(
      seen,
      Array.from({ length: 40 }, (_, index) => index + 1),
    );
  },
);

storageTest(
  'after a crash, a new instance continues the feed exactly where it was read',
  async ({ harness, instance }) => {
    const crashed = instance();

    for (let index = 0; index < 6; index += 1) {
      await crashed.backend.commit({
        append: [{ stream, events: [index] }],
      });
    }

    const read = await crashed.backend.feed({ after: 0, limit: 4 });
    const resumeAfter = read.commits.at(-1)?.position ?? 0;

    await harness.crash(crashed);

    const reopened = instance();
    const rest = await reopened.backend.feed({
      after: resumeAfter,
      limit: 100,
    });

    assert.deepEqual(
      rest.commits.map(({ position }) => position),
      [5, 6],
    );
    await reopened.backend.commit({ append: [{ stream, events: ['after'] }] });
    assert.deepEqual(
      (await reopened.backend.feed({ after: 6, limit: 10 })).commits.map(
        ({ position }) => position,
      ),
      [7],
    );
  },
);

storageTest(
  'blobs are content-addressed by sha256, idempotent and byte-exact',
  async ({ open }) => {
    const backend = open();
    const bytes = Buffer.from([0x00, 0xff, 0x00, 0x10, 0x80, 0x00]);
    const encoded = bytes.toString('base64');
    const { hash } = await backend.putBlob(encoded);

    assert.match(hash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(await backend.putBlob(encoded), { hash });
    assert.equal(await backend.getBlob(hash), encoded);
    assert.deepEqual(await backend.putBlob(''), {
      hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    assert.equal(await backend.getBlob(`sha256:${'0'.repeat(64)}`), undefined);
    assert.equal(await backend.getBlob('md5:abc'), undefined);
    await assert.rejects(
      backend.putBlob('not base64!'),
      isCode('invalid_input'),
    );
  },
);

storageTest(
  'the storage identity is created once and the same for every instance',
  async ({ open }) => {
    const first = open();
    const second = open();
    const [one, two] = await Promise.all([first.identity(), second.identity()]);

    assert.deepEqual(one, two);
    assert.equal(one.storageGeneration, 1);
    assert.match(
      one.hostId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.deepEqual(await open().identity(), one);
  },
);
