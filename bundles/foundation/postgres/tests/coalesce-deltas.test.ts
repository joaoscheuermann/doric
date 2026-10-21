import assert from 'node:assert/strict';
import test from 'node:test';

import type { StorageBackend } from 'bundle/contracts';

import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';
import { postgresHarness } from './support/harness.js';

// The delta-coalescing migration rewrites existing Thread event streams so a
// streamed response is one entry per run instead of one per token: the text
// a reader sees is the same, no sequence is renumbered, each stream still
// ends at its counter, nothing else changes, and the storage generation
// moves once so desktops drop the snapshots they hold of the old logs.

const coalesce = '20261021000000_coalesce_thread_deltas';

const projectId = '00000000-0000-4000-8000-0000000000b0';
const first = '00000000-0000-4000-8000-0000000000b1';
const second = '00000000-0000-4000-8000-0000000000b2';
const hostId = '00000000-0000-4000-8000-0000000000a0';
const p1 = '00000000-0000-4000-8000-0000000000c1';
const p2 = '00000000-0000-4000-8000-0000000000c2';

const threadStream = (threadId: string) => `runtime.thread.events/${threadId}`;
const otherStream = 'test.thread.events/elsewhere';

/** The creation time the seed gives the entry of a sequence. */
const at = (sequence: number) =>
  new Date(Date.UTC(2026, 9, 20) + sequence * 1000).toISOString();

type Event = Record<string, unknown>;

const text = (delta: unknown): Event => ({ type: 'text.delta', delta });
const reasoning = (delta: unknown): Event => ({
  type: 'reasoning.delta',
  delta,
});
const refusal = (delta: unknown): Event => ({ type: 'refusal.delta', delta });
const tool = (index: number, argumentsDelta?: string): Event => ({
  type: 'tool_call.delta',
  index,
  id: `call-${index}`,
  name: `tool-${index}`,
  ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
});
const plain = (type: string, fields: Event = {}): Event => ({
  type,
  ...fields,
});

interface Seed {
  readonly sequence: number;
  readonly promptId: string;
  readonly event: Event;
  /** Envelope fields beside the usual ones. */
  readonly extra?: Event;
}

const seedStream = async (
  database: TestDatabase,
  stream: string,
  threadId: string,
  lastSequence: number,
  entries: readonly Seed[],
) => {
  await database.query(
    'INSERT INTO "storage_stream" ("stream", "last_sequence") VALUES ($1, $2)',
    [stream, lastSequence],
  );
  await database.query(
    `INSERT INTO "storage_stream_entry" ("stream", "sequence", "value", "created_at")
     SELECT $1, (x->>'sequence')::integer, x->'value', (x->>'createdAt')::timestamptz
     FROM jsonb_array_elements($2::jsonb) x`,
    [
      stream,
      JSON.stringify(
        entries.map(({ sequence, promptId, event, extra }) => ({
          sequence,
          createdAt: at(sequence),
          value: {
            projectId,
            threadId,
            promptId,
            type: event.type,
            event,
            ...extra,
          },
        })),
      ),
    ],
  );
};

const seq = (
  sequence: number,
  promptId: string,
  event: Event,
  extra?: Event,
): Seed => ({ sequence, promptId, event, ...(extra ? { extra } : {}) });

/**
 * One long Thread: reasoning, an answer with blank deltas before it and a
 * comment inside it, interleaved tool calls, a refusal, a delta of an
 * unexpected shape, a rewind gap with its marker, two prompts side by side
 * and a run at the tail.
 */
const longThread: readonly Seed[] = [
  seq(
    1,
    p1,
    plain('prompt.accepted', { text: 'hi', source: { kind: 'user' } }),
  ),
  seq(2, p1, plain('prompt.started')),
  seq(3, p1, plain('response.started', { model: 'm' })),
  seq(4, p1, reasoning('Let')),
  seq(5, p1, reasoning('')),
  seq(6, p1, reasoning(' me')),
  seq(7, p1, reasoning(' think')),
  seq(8, p1, text('\n\n')),
  seq(9, p1, text(' ')),
  seq(10, p1, text('Hello')),
  seq(11, p1, reasoning('')),
  seq(12, p1, text(' world')),
  seq(13, p1, text('\n')),
  seq(14, p1, plain('comments.added/v1', { comments: [{ id: 'c1' }] })),
  seq(15, p1, text('More')),
  seq(16, p1, text('.')),
  // The call's name arrives before its arguments.
  seq(17, p1, tool(0)),
  seq(18, p1, tool(0, '{"path":"x"}')),
  seq(19, p1, tool(1, '{')),
  seq(20, p1, tool(2, '{')),
  seq(21, p1, tool(1, '}')),
  seq(22, p1, { type: 'tool_call.delta', index: 2 }),
  seq(23, p1, tool(2, '}')),
  seq(24, p1, plain('tool.started', { call: { id: 'call-0' } })),
  seq(25, p1, plain('usage', { usage: { input: 1 } })),
  seq(26, p1, refusal('No')),
  seq(27, p1, refusal('pe')),
  seq(28, p1, text(5)),
  seq(29, p1, text('x')),
  seq(30, p1, text('y')),
  // 31 to 34 were discarded by a rewind.
  seq(35, p1, plain('history.truncated', { afterSequence: 30 })),
  seq(36, p2, plain('prompt.accepted', { text: 'again' })),
  seq(37, p2, text('A')),
  seq(38, p1, text('B')),
  seq(39, p1, text('C')),
  seq(40, p2, reasoning('r')),
  seq(41, p2, text('D')),
  seq(42, p2, text('E')),
];

/** A Thread whose last entry is an empty delta, beside reasoning stamped in the envelope. */
const shortThread: readonly Seed[] = [
  seq(1, p1, plain('prompt.accepted', { text: 'x' })),
  seq(2, p1, reasoning('a'), { createdAt: '2026-10-20T00:00:02.000Z' }),
  seq(3, p1, reasoning('b'), { createdAt: '2026-10-20T00:00:03.000Z' }),
  seq(4, p1, text('c')),
  seq(5, p1, text('d')),
  seq(6, p1, text('')),
];

/** Deltas in a stream that is not a runtime Thread's. */
const otherEntries: readonly Seed[] = [
  seq(1, p1, text('a')),
  seq(2, p1, text('b')),
  seq(3, p1, text('')),
  seq(4, p1, plain('marker')),
];

const seedAll = async (database: TestDatabase) => {
  await seedStream(database, threadStream(first), first, 42, longThread);
  await seedStream(database, threadStream(second), second, 6, shortThread);
  await seedStream(database, otherStream, first, 4, otherEntries);
};

const seedIdentity = (database: TestDatabase, generation: number) =>
  database.query(
    `INSERT INTO "storage_meta" ("key", "value")
     VALUES ('identity', jsonb_build_object('hostId', $2::text, 'storageGeneration', $1::integer))`,
    [generation, hostId],
  );

/** A stream as `storage.backend/v1` reads it. */
const readAll = async (backend: StorageBackend, stream: string) => {
  const page = await backend.read({ stream, afterSequence: 0, limit: 1000 });

  return {
    lastSequence: page.lastSequence,
    entries: page.entries.map(({ sequence, value, createdAt }) => ({
      sequence,
      value: value as {
        type: string;
        promptId: string;
        createdAt?: string;
        event: Event;
      },
      createdAt,
    })),
  };
};

/** `[sequence, type, delta]`, the tool call's index joined to its type. */
const summary = (entries: Awaited<ReturnType<typeof readAll>>['entries']) =>
  entries.map(({ sequence, value }) => {
    const { event } = value;
    const type =
      typeof event.index === 'number'
        ? `${value.type}#${event.index}`
        : value.type;
    const delta = event.delta ?? event.argumentsDelta ?? null;

    return [sequence, type, delta];
  });

const snapshot = async (database: TestDatabase) => ({
  entries: await database.query(
    `SELECT "stream", "sequence", "value"::text AS "value", "created_at"
     FROM "storage_stream_entry" ORDER BY "stream", "sequence"`,
  ),
  streams: await database.query(
    'SELECT * FROM "storage_stream" ORDER BY "stream"',
  ),
  identity: await database.query(
    `SELECT "value"::text AS "value" FROM "storage_meta" WHERE "key" = 'identity'`,
  ),
});

const coalesceTest = (
  name: string,
  run: (context: {
    readonly database: TestDatabase;
    readonly open: () => StorageBackend;
  }) => Promise<void>,
) => {
  void test(name, { skip: skipWithoutDatabase }, async () => {
    const database = await createTestDatabase({ until: coalesce });
    const harness = postgresHarness(database);
    const instances: ReturnType<typeof harness.open>[] = [];

    try {
      await run({
        database,
        open: () => {
          const instance = harness.open();

          instances.push(instance);
          return instance.backend;
        },
      });
    } finally {
      for (const instance of instances) await instance.dispose();
      await database.close();
    }
  });
};

coalesceTest(
  'each run of deltas becomes its first entry with the whole text, and nothing else moves',
  async ({ database, open }) => {
    await seedAll(database);
    await seedIdentity(database, 4);
    await database.migrate(coalesce);

    const backend = open();
    const long = await readAll(backend, threadStream(first));

    assert.deepEqual(summary(long.entries), [
      [1, 'prompt.accepted', null],
      [2, 'prompt.started', null],
      [3, 'response.started', null],
      [4, 'reasoning.delta', 'Let me think'],
      // The blank deltas before the answer stay apart from it.
      [8, 'text.delta', '\n\n '],
      [10, 'text.delta', 'Hello world\n'],
      [14, 'comments.added/v1', null],
      [15, 'text.delta', 'More.'],
      [17, 'tool_call.delta#0', '{"path":"x"}'],
      [19, 'tool_call.delta#1', '{'],
      [20, 'tool_call.delta#2', '{'],
      [21, 'tool_call.delta#1', '}'],
      [23, 'tool_call.delta#2', '}'],
      [24, 'tool.started', null],
      [25, 'usage', null],
      [26, 'refusal.delta', 'Nope'],
      [28, 'text.delta', 5],
      [29, 'text.delta', 'xy'],
      [35, 'history.truncated', null],
      [36, 'prompt.accepted', null],
      [37, 'text.delta', 'A'],
      [38, 'text.delta', 'BC'],
      [40, 'reasoning.delta', 'r'],
      // The run at the tail is left as it was.
      [41, 'text.delta', 'D'],
      [42, 'text.delta', 'E'],
    ]);

    // A coalesced entry was written when its last delta was; the others keep
    // their own time, and every entry keeps its prompt and its event fields.
    const created = new Map(
      long.entries.map(({ sequence, createdAt }) => [sequence, createdAt]),
    );

    assert.equal(created.get(4), at(7));
    assert.equal(created.get(8), at(9));
    assert.equal(created.get(10), at(13));
    assert.equal(created.get(17), at(18));
    assert.equal(created.get(19), at(19));
    assert.equal(created.get(41), at(41));
    assert.deepEqual(
      long.entries.find(({ sequence }) => sequence === 17),
      {
        sequence: 17,
        createdAt: at(18),
        value: {
          projectId,
          threadId: first,
          promptId: p1,
          type: 'tool_call.delta',
          event: {
            type: 'tool_call.delta',
            index: 0,
            id: 'call-0',
            name: 'tool-0',
            argumentsDelta: '{"path":"x"}',
          },
        },
      },
    );
    assert.equal(
      long.entries.find(({ sequence }) => sequence === 38)?.value.promptId,
      p1,
    );

    // The counter stays, and the stream still ends at it.
    assert.equal(long.lastSequence, 42);
    assert.equal(long.entries.at(-1)?.sequence, 42);

    const short = await readAll(backend, threadStream(second));

    assert.deepEqual(summary(short.entries), [
      [1, 'prompt.accepted', null],
      [2, 'reasoning.delta', 'ab'],
      // The tail's run, its empty last delta included, is not touched.
      [4, 'text.delta', 'c'],
      [5, 'text.delta', 'd'],
      [6, 'text.delta', ''],
    ]);
    assert.equal(short.entries[1]?.value.createdAt, '2026-10-20T00:00:03.000Z');
    assert.equal(short.entries[1]?.createdAt, at(3));
    assert.equal(short.lastSequence, 6);

    // Another bundle's stream is not a Thread's log.
    const other = await readAll(backend, otherStream);

    assert.deepEqual(summary(other.entries), [
      [1, 'text.delta', 'a'],
      [2, 'text.delta', 'b'],
      [3, 'text.delta', ''],
      [4, 'marker', null],
    ]);
    assert.equal(other.lastSequence, 4);

    assert.deepEqual(await backend.identity(), {
      hostId,
      storageGeneration: 5,
    });

    // The next append continues the counter.
    const { position } = await backend.commit({
      append: [
        {
          stream: threadStream(first),
          events: [
            {
              projectId,
              threadId: first,
              promptId: p2,
              type: 'text.delta',
              event: text('F'),
            },
          ],
        },
      ],
    });

    assert.ok(position > 0);
    assert.deepEqual(
      (await readAll(backend, threadStream(first))).entries
        .slice(-1)
        .map(({ sequence }) => sequence),
      [43],
    );
  },
);

coalesceTest(
  'applied again it changes nothing and moves the generation only once',
  async ({ database, open }) => {
    await seedAll(database);
    await seedIdentity(database, 1);
    await database.migrate(coalesce);

    const migrated = await snapshot(database);

    await database.migrate(coalesce);
    assert.deepEqual(await snapshot(database), migrated);

    // Even without its record of having run, the coalescing is a fixpoint:
    // nothing changes, so nothing invalidates the desktops' snapshots.
    await database.query(
      `DELETE FROM "storage_meta" WHERE "key" = 'coalesced-thread-deltas'`,
    );
    await database.migrate(coalesce);
    assert.deepEqual(await snapshot(database), migrated);
    assert.equal((await open().identity()).storageGeneration, 2);
  },
);

coalesceTest(
  'a log with nothing to coalesce keeps the generation',
  async ({ database, open }) => {
    await seedStream(database, threadStream(first), first, 3, [
      seq(1, p1, plain('prompt.accepted', { text: 'x' })),
      seq(2, p1, text('one')),
      seq(3, p1, plain('prompt.finished', { status: 'completed' })),
    ]);
    await seedIdentity(database, 3);

    const before = await snapshot(database);

    await database.migrate(coalesce);
    assert.deepEqual(await snapshot(database), before);
    assert.equal((await open().identity()).storageGeneration, 3);
  },
);

coalesceTest(
  'a database that never had an identity is not given one',
  async ({ database, open }) => {
    await seedAll(database);
    await database.migrate(coalesce);

    assert.deepEqual(
      await database.query(
        `SELECT 1 FROM "storage_meta" WHERE "key" = 'identity'`,
      ),
      [],
    );
    // The first host to read it starts at generation 1, as on any new database.
    assert.equal((await open().identity()).storageGeneration, 1);
  },
);

coalesceTest(
  'a result that cannot be verified aborts the whole migration',
  async ({ database }) => {
    await seedAll(database);
    await seedIdentity(database, 4);

    // A test-only fault: every rewritten entry gains a character.
    await database.query(`
      CREATE FUNCTION "corrupt_delta"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."value"->'event' ? 'delta' THEN
          NEW."value" := jsonb_set(NEW."value", '{event,delta}',
            to_jsonb((NEW."value"->'event'->>'delta') || '!'));
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER "corrupt_delta" BEFORE UPDATE ON "storage_stream_entry"
        FOR EACH ROW EXECUTE FUNCTION "corrupt_delta"();
    `);

    const before = await snapshot(database);

    await assert.rejects(database.migrate(coalesce), {
      message: /^The Thread delta coalescing could not be verified/u,
    });
    await database.query('ROLLBACK');
    assert.deepEqual(await snapshot(database), before);
    assert.deepEqual(
      await database.query(
        `SELECT 1 FROM "storage_meta" WHERE "key" = 'coalesced-thread-deltas'`,
      ),
      [],
    );
  },
);

/** Two runs of the same kind of the same prompt, a comment between them. */
const twoRuns: readonly Seed[] = [
  seq(1, p1, plain('prompt.accepted', { text: 'x' })),
  seq(2, p1, text('a')),
  seq(3, p1, text('b')),
  seq(4, p1, plain('comments.added/v1', { comments: [{ id: 'c1' }] })),
  seq(5, p1, text('c')),
  seq(6, p1, text('d')),
  seq(7, p1, plain('prompt.finished', { status: 'completed' })),
];

coalesceTest(
  'two runs of the same kind with another entry between them stay two entries',
  async ({ database, open }) => {
    await seedStream(database, threadStream(first), first, 7, twoRuns);
    await database.migrate(coalesce);

    assert.deepEqual(
      summary((await readAll(open(), threadStream(first))).entries),
      [
        [1, 'prompt.accepted', null],
        [2, 'text.delta', 'ab'],
        [4, 'comments.added/v1', null],
        [5, 'text.delta', 'cd'],
        [7, 'prompt.finished', null],
      ],
    );
  },
);

coalesceTest(
  'a merge across two runs of the same kind cannot be verified, though the text is all there',
  async ({ database }) => {
    await seedStream(database, threadStream(first), first, 7, twoRuns);

    // A test-only fault: the first run takes the second's text and the
    // second's first entry goes, so each kind still holds 'abcd' in order.
    await database.query(`
      CREATE FUNCTION "merge_across_runs"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          IF NEW."sequence" = 2 THEN
            NEW."value" := jsonb_set(NEW."value", '{event,delta}', '"abcd"');
          END IF;
          RETURN NEW;
        END IF;
        IF OLD."sequence" = 3 THEN
          DELETE FROM "storage_stream_entry"
          WHERE "stream" = OLD."stream" AND "sequence" = 5;
        END IF;
        RETURN OLD;
      END $$;
      CREATE TRIGGER "merge_across_runs" BEFORE UPDATE OR DELETE ON "storage_stream_entry"
        FOR EACH ROW EXECUTE FUNCTION "merge_across_runs"();
    `);

    const before = await snapshot(database);

    await assert.rejects(database.migrate(coalesce), {
      message: /^The Thread delta coalescing could not be verified/u,
    });
    await database.query('ROLLBACK');
    assert.deepEqual(await snapshot(database), before);
  },
);
