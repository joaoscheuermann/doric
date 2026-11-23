// `files/v1` served by `files`' host part through the router (phase 3, slice
// S53b, tests F1–F8): each method runs on the calling Project's current lease
// over `runtime.lease/v1` (one `Describe`, then steps bound to that sandbox),
// with the scope `{projectId}` only. A lease that is not ready, or lost
// between steps, is an answer (`{status}`); any other failure keeps its code.
// `ReadBytes` streams one head, then the kept bytes in chunks of 1 MiB at most.

import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';

import { type JsonValue, toJson } from '@bufbuild/protobuf';
import { type CallScope, ContractError } from 'bundle/contracts';
import { leaseScopeMessage } from 'runtime/contracts';

import {
  ContentResponseSchema,
  CreateDirectoryResponseSchema,
  CreateFileResponseSchema,
  DirectoriesResponseSchema,
  DirectoryResponseSchema,
  TreeResponseSchema,
} from '../src/contracts/gen/doric/files/v1/files_pb.js';
import { BYTES_LIMIT } from '../src/host/reads.js';
import { fakeHost } from './fake-sandbox.js';
import { type Harness, harness, MIB, promptScope } from './support/router.js';
import {
  bytesOf,
  commandSandbox,
  filesPart,
  itemsJson,
  itemsOf,
  NOT_READY,
} from './support/router-files.js';
import {
  callsOf,
  rejectionOf,
  targetOf,
  workspace,
} from './support/router-fixtures.js';

/** The workspace every case reads, unless it names its own. */
const FILES = { 'README.md': 'hello', 'src/a.ts': 'export const a = 1;\n' };

/** Each of the seven methods, called once on `h` under `scope`, its answer as JSON. */
const methods = (
  h: Harness,
  scope?: CallScope,
): Record<string, () => Promise<JsonValue>> => {
  const files = h.files(scope);

  return {
    Directory: async () =>
      toJson(DirectoryResponseSchema, await files.directory({ path: 'src' })),
    Tree: async () => toJson(TreeResponseSchema, await files.tree({})),
    Directories: async () =>
      toJson(
        DirectoriesResponseSchema,
        await files.directories({ paths: ['', 'src'] }),
      ),
    Content: async () =>
      toJson(ContentResponseSchema, await files.content({ path: 'README.md' })),
    ReadBytes: async () =>
      itemsJson(await itemsOf(files.readBytes({ path: 'README.md' }))),
    CreateFile: async () =>
      toJson(
        CreateFileResponseSchema,
        await files.createFile({ directory: 'src', name: 'new.ts' }),
      ),
    CreateDirectory: async () =>
      toJson(
        CreateDirectoryResponseSchema,
        await files.createDirectory({ directory: 'src', name: 'new-dir' }),
      ),
  };
};

/** The part over a fresh workspace of `files`. */
const part = async (
  t: TestContext,
  files: Readonly<Record<string, string | Uint8Array>> = FILES,
): Promise<{ readonly h: Harness; readonly root: string }> => {
  const root = await workspace(t, files);

  return { h: await filesPart(t, root), root };
};

/** Whether `file` exists under `root`. */
const exists = (root: string, file: string): Promise<boolean> =>
  stat(path.join(root, file)).then(
    () => true,
    () => false,
  );

// F1.
void test('F1: before activate, every files/v1 method answers unavailable', async (t) => {
  const root = await workspace(t, FILES);
  const h = harness({
    sandbox: commandSandbox(root),
    host: fakeHost({ localRoot: root }),
  });

  t.after(() => h.router.control.stop());
  await h.serveWithoutActivate();

  for (const [name, call] of Object.entries(methods(h))) {
    const error = await rejectionOf(call());

    assert.equal(error.code, 'unavailable', name);
  }
  assert.deepEqual(callsOf(h, 'lease'), []);
});

// F2.
void test('F2: a scope without projectId fails invalid_input with leaseScopeMessage, before any lease call', async (t) => {
  const { h } = await part(t);

  for (const [name, call] of Object.entries(
    methods(h, { threadId: 'thread-1' }),
  )) {
    const error = await rejectionOf(call());

    assert.equal(error.code, 'invalid_input', name);
    assert.equal(error.message, leaseScopeMessage, name);
  }
  assert.deepEqual(callsOf(h, 'lease'), []);
});

// F3.
void test('F3: under a prompt scope, every lease call carries the scope {projectId} only', async (t) => {
  const { h } = await part(t);

  for (const [name, call] of Object.entries(methods(h, promptScope))) {
    const before = h.calls.length;

    await call();

    const leaseCalls = h.calls
      .slice(before)
      .filter((made) => made.service === 'lease');

    assert.ok(leaseCalls.length > 0, `${name} made no lease call`);
    for (const made of leaseCalls) {
      assert.deepEqual(made.scope, { projectId: 'project-1' }, name);
    }
  }
});

// F4.
void test('F4: a lease that is not ready is each method’s answer {status}, with no value and no Exec', async (t) => {
  const { h } = await part(t);

  for (const state of NOT_READY) {
    h.lease.status = state;

    for (const [name, call] of Object.entries(methods(h))) {
      const before = h.calls.length;
      const answer = await call();

      assert.deepEqual(
        answer,
        name === 'ReadBytes'
          ? [{ head: { status: state } }]
          : { status: state },
        `${name} under ${state}`,
      );

      const made = h.calls.slice(before).filter((c) => c.service === 'lease');

      assert.deepEqual(
        made.map((c) => c.method),
        ['describe'],
        `${name} under ${state}`,
      );
    }
  }
});

// F5.
void test('F5: a lease lost after Describe answers Content and CreateFile {status: unavailable}, and creates nothing', async (t) => {
  const { h, root } = await part(t);

  h.lease.switchAfterDescribe = 'other-sandbox';
  assert.deepEqual(
    toJson(
      ContentResponseSchema,
      await h.files().content({ path: 'README.md' }),
    ),
    { status: 'unavailable' },
  );

  h.lease.sandboxId = 'fake-sandbox';
  h.lease.switchAfterDescribe = 'third-sandbox';
  assert.deepEqual(
    toJson(
      CreateFileResponseSchema,
      await h.files().createFile({ directory: 'src', name: 'new.ts' }),
    ),
    { status: 'unavailable' },
  );
  assert.equal(await exists(root, 'src/new.ts'), false);

  for (const made of callsOf(h, 'lease', 'exec')) {
    assert.deepEqual(targetOf(made), { expectSandboxId: 'fake-sandbox' });
  }
});

// F6.
void test('F6: Directories with no path or with 1001 paths fails invalid_input before the handler', async (t) => {
  const { h } = await part(t);
  const files = h.files();

  for (const paths of [[], Array.from({ length: 1001 }, (_, i) => `d${i}`)]) {
    const error = await rejectionOf(files.directories({ paths }));

    assert.equal(error.code, 'invalid_input', `${paths.length} paths`);
  }
  assert.deepEqual(callsOf(h, 'lease'), []);
});

// F7.
void test('F7: ReadBytes of a 3 MiB file answers the head, then three chunks of at most 1 MiB that join to the file', async (t) => {
  const content = Buffer.alloc(3 * MIB, 'abc');
  const { h } = await part(t, { 'three.txt': content });

  const items = await itemsOf(h.files().readBytes({ path: 'three.txt' }));
  const json = itemsJson(items);

  assert.deepEqual(json[0], {
    head: {
      status: 'ready',
      value: {
        status: 'read',
        path: 'three.txt',
        truncated: false,
        binary: false,
      },
    },
  });
  assert.equal(items.length, 4);
  for (const item of items.slice(1)) {
    assert.equal(item.item.case, 'chunk');
    assert.ok(item.item.case === 'chunk' && item.item.value.length <= MIB);
  }
  assert.ok(bytesOf(items).equals(content));

  const reads = callsOf(h, 'lease', 'readFileBytes');

  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0]?.request, {
    target: { expectSandboxId: 'fake-sandbox' },
    request: { path: '/workspace/three.txt' },
  });
});

void test('F7: ReadBytes of an empty file answers the head alone', async (t) => {
  const { h } = await part(t, { 'empty.txt': '' });

  assert.deepEqual(
    itemsJson(await itemsOf(h.files().readBytes({ path: 'empty.txt' }))),
    [
      {
        head: {
          status: 'ready',
          value: {
            status: 'read',
            path: 'empty.txt',
            truncated: false,
            binary: false,
          },
        },
      },
    ],
  );
});

void test('F7: ReadBytes of a file over 4 MiB keeps exactly BYTES_LIMIT bytes, truncated, and cancels the read stream', async (t) => {
  const content = Buffer.alloc(10 * MIB, 'z');
  const { h } = await part(t, { 'big.txt': content });

  const items = await itemsOf(h.files().readBytes({ path: 'big.txt' }));

  assert.deepEqual(itemsJson(items)[0], {
    head: {
      status: 'ready',
      value: {
        status: 'read',
        path: 'big.txt',
        truncated: true,
        binary: false,
      },
    },
  });
  assert.ok(bytesOf(items).equals(content.subarray(0, BYTES_LIMIT)));
  assert.ok(
    h.lease.bytesPulled > BYTES_LIMIT && h.lease.chunksPulled < 10,
    `${h.lease.bytesPulled} bytes in ${h.lease.chunksPulled} chunks were pulled`,
  );
});

void test('F7: ReadBytes answers binary when the bytes read hold a NUL', async (t) => {
  const content = Buffer.from([0x61, 0x00, 0x62]);
  const { h } = await part(t, { 'nul.bin': content, 'text.txt': 'ab' });

  const nul = await itemsOf(h.files().readBytes({ path: 'nul.bin' }));
  const text = await itemsOf(h.files().readBytes({ path: 'text.txt' }));

  assert.deepEqual(itemsJson(nul), [
    {
      head: {
        status: 'ready',
        value: {
          status: 'read',
          path: 'nul.bin',
          truncated: false,
          binary: true,
        },
      },
    },
    { chunk: 3 },
  ]);
  assert.ok(bytesOf(nul).equals(content));
  assert.deepEqual(itemsJson(text)[0], {
    head: {
      status: 'ready',
      value: {
        status: 'read',
        path: 'text.txt',
        truncated: false,
        binary: false,
      },
    },
  });
});

void test('F7: ReadBytes of a missing path, a directory or ../x answers that read status and no chunk', async (t) => {
  const { h } = await part(t);

  for (const [asked, status] of [
    ['missing.txt', 'not_found'],
    ['src', 'not_file'],
    ['../x', 'invalid_path'],
  ] as const) {
    assert.deepEqual(
      itemsJson(await itemsOf(h.files().readBytes({ path: asked }))),
      [{ head: { status: 'ready', value: { status } } }],
      asked,
    );
  }
  assert.deepEqual(callsOf(h, 'lease', 'readFileBytes'), []);
});

void test('F7 (Q4): a byte read failing after the probe said file rejects with the read’s code', async (t) => {
  const { h } = await part(t);

  h.lease.readBytesError = new ContractError('not_found', 'No such file.');

  const error = await rejectionOf(
    itemsOf(h.files().readBytes({ path: 'README.md' })),
  );

  assert.equal(error.code, 'not_found');
});

// F8.
void test('F8: an Exec failure that is not a lease failure keeps its code', async (t) => {
  const { h, root } = await part(t);

  h.lease.execError = new ContractError('internal', 'The sandbox broke.');

  for (const [name, call] of Object.entries(methods(h))) {
    const error = await rejectionOf(call());

    assert.equal(error.code, 'internal', name);
    assert.equal(error.message, 'The sandbox broke.', name);
  }
  assert.equal(await exists(root, 'src/new.ts'), false);
  assert.equal(await exists(root, 'src/new-dir'), false);
});
