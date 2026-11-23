/**
 * SEA entry of the `sqlite-node` stand-in (phase 0 spike, T0.1): the engine
 * bundle of phase 4 does not exist yet, so the stand-in opens an in-memory
 * database with `node:sqlite` and writes and reads one key, which is the work
 * and the memory an idle engine adds to a process.
 */
import { DatabaseSync } from 'node:sqlite';

import { run } from '../client.js';

await run(() => {
  const database = new DatabaseSync(':memory:');
  database.exec(
    'CREATE TABLE kv (key BLOB PRIMARY KEY, value BLOB, version REAL)',
  );
  database
    .prepare('INSERT INTO kv (key, value, version) VALUES (?, ?, ?)')
    .run(Buffer.from('doric/meta'), Buffer.from('{}'), 1);
  const row = database.prepare('SELECT count(*) AS keys FROM kv').get() as {
    keys: number;
  };
  return { keys: row.keys };
});
