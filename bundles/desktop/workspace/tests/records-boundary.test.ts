// Bundle isolation AC3.1 (docs/designs/bundle-isolation.md): from phase 3 the
// workspace's client part (step 4(c), decision O10) calls no method of `runtime/v1` or `runtime.threads/v1`.
// It reads and writes Projects and Threads through `runtime.records/v1` only,
// so no source file under `src` names either host contract or its ref.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

/** Every file under `directory`, at any depth. */
const filesUnder = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });

const forbidden = [
  /\bRuntimeV1\b/,
  /\bRuntimeThreadsV1\b/,
  /'runtime\/v1'/,
  /'runtime\.threads\/v1'/,
];

describe('the workspace reaches the host records only through runtime.records/v1 (AC3.1)', () => {
  test('no file under src names RuntimeV1, RuntimeThreadsV1, runtime/v1 or runtime.threads/v1', () => {
    const files = filesUnder('bundles/desktop/workspace/src');
    assert.ok(files.length > 0, 'The workspace has no source file to read.');

    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          forbidden.some((pattern) => pattern.test(line))
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );

    assert.deepEqual(found, []);
  });
});

// Bundle isolation AC4.12 (step 4(e), O5): the layout's navigation contracts
// left with workspace 1.0.0, and with them the one contracts module that read
// the record types, so `workspace/contracts` imports nothing of
// `runtime/contracts`.
describe('the workspace contracts do not depend on runtime/contracts (AC4.12)', () => {
  test('no file under src/contracts imports runtime/contracts', () => {
    const files = filesUnder('bundles/desktop/workspace/src/contracts');
    assert.ok(files.length > 0, 'The workspace has no contracts file to read.');

    const found = files.flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          /from 'runtime\/contracts'/.test(line)
            ? [`${file}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );

    assert.deepEqual(found, []);
  });
});
