// T4.18 (AC4.18, Q9): the storage path and the file format of the `sqlite`
// engine bundle, started directly through `startTestProcess`.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { isContractError } from 'bundle/contracts';
import { startTestProcess } from 'bundle/testing';

const caseTimeoutMs = 120_000;

// From `packages/storage/dist-tests/tests/` to the repository root.
const binary = fileURLToPath(
  new URL('../../../../dist/target/doric-sqlite/debug/doric-sqlite', import.meta.url),
);

const storageFile = 'doric.sqlite3';

/** Starts the engine with `env` on top of the test's environment, then stops it. */
const startAndStop = async (env?: Readonly<Record<string, string>>): Promise<void> => {
  const started = await startTestProcess({
    bundleId: 'sqlite',
    command: [binary],
    ...(env === undefined ? {} : { env }),
  });

  await started.stop();
};

/** An `assert.rejects` matcher for a `ContractError` of `code`. */
const code =
  (expected: string) =>
  (error: unknown): boolean => {
    assert.ok(isContractError(error), `expected ${expected}, got ${String(error)}`);
    assert.equal(error.code, expected, error.message);

    return true;
  };

describe('sqlite storage path and format', { timeout: caseTimeoutMs }, () => {
  const savedCwd = process.cwd();
  const savedPath = process.env.DORIC_STORAGE_PATH;
  let root = '';

  before(async () => {
    assert.ok(existsSync(binary), `doric-sqlite is not built: run npx nx run sqlite:compile (${binary})`);
    root = await mkdtemp(join(tmpdir(), 'doric-kv-file-'));
  });

  after(async () => {
    process.chdir(savedCwd);

    if (savedPath === undefined) {
      delete process.env.DORIC_STORAGE_PATH;
    } else {
      process.env.DORIC_STORAGE_PATH = savedPath;
    }

    await rm(root, { recursive: true, force: true });
  });

  test('with DORIC_STORAGE_PATH unset, the engine creates doric.sqlite3 in its working directory', async () => {
    const cwd = await mkdtemp(join(root, 'unset-'));

    delete process.env.DORIC_STORAGE_PATH;
    process.chdir(cwd);

    try {
      await startAndStop();
    } finally {
      process.chdir(savedCwd);
    }

    assert.equal(existsSync(join(cwd, storageFile)), true);
  });

  test('with DORIC_STORAGE_PATH empty, the engine creates doric.sqlite3 in its working directory', async () => {
    const cwd = await mkdtemp(join(root, 'empty-'));

    delete process.env.DORIC_STORAGE_PATH;
    process.chdir(cwd);

    try {
      await startAndStop({ DORIC_STORAGE_PATH: '' });
    } finally {
      process.chdir(savedCwd);
    }

    assert.equal(existsSync(join(cwd, storageFile)), true);
  });

  test('DORIC_STORAGE_PATH set to a missing directory fails the activation with storage_path_missing and creates nothing', async () => {
    const missing = join(root, 'missing');

    await assert.rejects(
      startAndStop({ DORIC_STORAGE_PATH: missing }),
      code('storage_path_missing'),
    );
    assert.equal(existsSync(missing), false, 'the directory still does not exist');
  });

  test('a store whose user_version is 2 fails the activation with storage_format_unsupported and stays as it was', async () => {
    const dir = await mkdtemp(join(root, 'format-'));
    const file = join(dir, storageFile);

    await startAndStop({ DORIC_STORAGE_PATH: dir });

    const original = await readFile(file);
    const patched = Buffer.from(original);

    // The header's `user_version`: 4 bytes, big-endian, at offset 60.
    patched.writeUInt32BE(2, 60);
    await writeFile(file, patched);

    await assert.rejects(
      startAndStop({ DORIC_STORAGE_PATH: dir }),
      code('storage_format_unsupported'),
    );
    assert.deepEqual(await readFile(file), patched, 'the file\'s bytes are unchanged');
    assert.equal(existsSync(`${file}-wal`), false, 'no -wal file exists');
  });
});
