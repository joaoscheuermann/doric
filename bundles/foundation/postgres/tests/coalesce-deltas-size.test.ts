import assert from 'node:assert/strict';
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

import type { StorageBackend } from 'bundle/contracts';

import {
  createTestDatabase,
  skipWithoutDatabase,
  type TestDatabase,
} from './support/database.js';
import { postgresHarness } from './support/harness.js';

/*
 * What the delta-coalescing migration saves on a long Thread: a ~100k-entry
 * log with the mix measured on a real one (about 75k reasoning, 14k tool-call
 * and 7.7k text deltas around 2.4k other events, in ~400 responses), migrated,
 * then read whole through `storage.backend/v1` as a replay does. The entry
 * counts, payload bytes and the heap the read retains are reported, not
 * asserted, since they depend on the machine. Opt-in: set
 * `DORIC_TEST_COALESCE_SIZE=1` beside `DORIC_TEST_DATABASE_URL`.
 */

const coalesce = '20261021000000_coalesce_thread_deltas';
const threadId = '00000000-0000-4000-8000-0000000000d1';
const stream = `runtime.thread.events/${threadId}`;
const responses = 405;

const skip =
  skipWithoutDatabase ||
  (process.env.DORIC_TEST_COALESCE_SIZE === '1'
    ? false
    : 'DORIC_TEST_COALESCE_SIZE is not set');

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/**
 * One response of 247 entries: started, 187 reasoning deltas, 19 text
 * deltas, 35 deltas of one tool call, and its done, started, finished, usage
 * and response-finished events; prompt 0 opens the log.
 */
const seed = (database: TestDatabase) =>
  database.query(
    `WITH "slot" AS (
       SELECT r, k, 1 + r * 247 + k + 1 AS "sequence"
       FROM generate_series(0, $2::integer - 1) r, generate_series(0, 246) k
     ),
     "event" AS (
       SELECT "sequence", CASE
         WHEN k = 0 THEN jsonb_build_object('type', 'response.started', 'model', 'm')
         WHEN k <= 187 THEN jsonb_build_object('type', 'reasoning.delta', 'delta', 'thought ' || k || ' ')
         WHEN k <= 206 THEN jsonb_build_object('type', 'text.delta', 'delta', 'word ' || k || ' ')
         WHEN k <= 241 THEN jsonb_build_object('type', 'tool_call.delta', 'index', 0,
           'id', 'call-' || r, 'name', 'terminal', 'argumentsDelta', '{"chunk":' || k || '}')
         WHEN k = 242 THEN jsonb_build_object('type', 'tool_call.done', 'call', jsonb_build_object('id', 'call-' || r))
         WHEN k = 243 THEN jsonb_build_object('type', 'tool.started', 'call', jsonb_build_object('id', 'call-' || r))
         WHEN k = 244 THEN jsonb_build_object('type', 'tool.finished', 'call', jsonb_build_object('id', 'call-' || r),
           'record', jsonb_build_object('output', repeat('out ', 200)))
         WHEN k = 245 THEN jsonb_build_object('type', 'usage', 'usage', jsonb_build_object('input', 1000, 'output', 200))
         ELSE jsonb_build_object('type', 'response.finished')
       END AS "event"
       FROM "slot"
       UNION ALL
       SELECT 1, jsonb_build_object('type', 'prompt.accepted', 'text', 'go')
     ),
     "stream" AS (
       INSERT INTO "storage_stream" ("stream", "last_sequence")
       VALUES ($1, 1 + $2::integer * 247)
     )
     INSERT INTO "storage_stream_entry" ("stream", "sequence", "value", "created_at")
     SELECT $1, "sequence",
       jsonb_build_object(
         'projectId', '00000000-0000-4000-8000-0000000000d0',
         'threadId', $3::text,
         'promptId', '00000000-0000-4000-8000-0000000000d2',
         'type', "event"->>'type',
         'event', "event"
       ),
       TIMESTAMPTZ '2026-10-20T00:00:00Z' + "sequence" * INTERVAL '1 millisecond'
     FROM "event"`,
    [stream, responses, threadId],
  );

const measureTable = async (database: TestDatabase) => {
  const [row] = await database.query<{ entries: string; bytes: string }>(
    `SELECT count(*) AS "entries", sum(pg_column_size("value")) AS "bytes"
     FROM "storage_stream_entry" WHERE "stream" = $1`,
    [stream],
  );

  return { entries: Number(row?.entries), bytes: Number(row?.bytes) };
};

/** The whole log read as a replay reads it, and the heap it keeps alive. */
const fullRead = async (backend: StorageBackend) => {
  gc();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const entries: unknown[] = [];
  let afterSequence = 0;

  for (;;) {
    const page = await backend.read({ stream, afterSequence, limit: 1000 });

    entries.push(...page.entries);
    const last = page.entries.at(-1);

    if (last === undefined || last.sequence >= page.lastSequence) break;
    afterSequence = last.sequence;
  }

  const elapsed = performance.now() - started;

  gc();
  const retained = process.memoryUsage().heapUsed - before;

  return { entries: entries.length, retained, elapsed, kept: entries };
};

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

void test('a ~100k-entry Thread log before and after coalescing', {
  skip,
}, async (context) => {
  const database = await createTestDatabase({ until: coalesce });
  const harness = postgresHarness(database);
  const instance = harness.open();

  try {
    await seed(database);

    const before = await measureTable(database);
    const readBefore = await fullRead(instance.backend);

    readBefore.kept.length = 0;

    const started = performance.now();

    await database.migrate(coalesce);

    const migration = performance.now() - started;
    const after = await measureTable(database);
    const readAfter = await fullRead(instance.backend);

    context.diagnostic(
      `entries ${before.entries} -> ${after.entries}; value bytes ${mib(before.bytes)} -> ${mib(after.bytes)}; migration ${migration.toFixed(0)} ms`,
    );
    context.diagnostic(
      `full read ${readBefore.elapsed.toFixed(0)} ms, ${mib(readBefore.retained)} retained -> ${readAfter.elapsed.toFixed(0)} ms, ${mib(readAfter.retained)} retained`,
    );

    // 405 responses of one reasoning, text and tool-call run each, and their
    // six other events, plus the prompt.
    assert.equal(before.entries, 1 + responses * 247);
    assert.equal(after.entries, 1 + responses * (3 + 6));
    assert.equal(readAfter.entries, after.entries);
    assert.equal(
      (await instance.backend.read({ stream, afterSequence: 0, limit: 1 }))
        .lastSequence,
      1 + responses * 247,
    );
  } finally {
    await instance.dispose();
    await database.close();
  }
});
