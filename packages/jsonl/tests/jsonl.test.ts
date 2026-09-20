import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { jsonl, JsonlParseError } from '../src/index.js';

test('writes one JSON line when append receives a record', async () => {
  await withTempJsonl(async (path) => {
    const file = jsonl(path);

    await file.append({ id: 'one', nested: { ok: true } });

    await file.close();

    assert.equal(
      await readFile(path, 'utf8'),
      '{"id":"one","nested":{"ok":true}}\n',
    );
  });
});

test('preserves call order when append is called concurrently', async () => {
  await withTempJsonl(async (path) => {
    const file = jsonl(path);

    await Promise.all([
      file.append({ index: 1 }),
      file.append({ index: 2 }),
      file.append({ index: 3 }),
    ]);

    await file.close();

    assert.equal(
      await readFile(path, 'utf8'),
      '{"index":1}\n{"index":2}\n{"index":3}\n',
    );
  });
});

test('streams parsed records when read receives JSON lines', async () => {
  await withTempJsonl(async (path) => {
    await writeFile(
      path,
      '{"kind":"started"}\n{"kind":"finished","ok":true}\n',
    );

    const records = [];

    for await (const record of jsonl(path).read()) {
      records.push(record);
    }

    assert.deepEqual(records, [
      { kind: 'started' },
      { kind: 'finished', ok: true },
    ]);
  });
});

test('rejects with line context when read receives invalid JSON', async () => {
  await withTempJsonl(async (path) => {
    await writeFile(path, '{"kind":"started"}\nnot json\n');

    await assert.rejects(
      async () => {
        for await (const record of jsonl(path).read()) {
          void record;
        }
      },
      (error: unknown) => {
        assert.ok(error instanceof JsonlParseError);

        assert.equal(error.path, path);

        assert.equal(error.lineNumber, 2);

        assert.equal(error.line, 'not json');

        return true;
      },
    );
  });
});

async function withTempJsonl(
  testFile: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
  const path = join(dir, 'events.jsonl');

  try {
    await testFile(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
