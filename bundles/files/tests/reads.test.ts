// files/v1 (stage 10, §3.6) and the window's reads over it: the Project
// sandbox reads of the file panel and the file tab, through a fake
// runtime.lease/v1 whose lease is either held (the task runs on a sandbox
// backed by a local directory) or in one of its other states. The window side
// is observed as the REST client answered: lease states and refusals are
// data, `pending` carries `Retry-After: 1`, a failed call is a sentence.

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  type CallScope,
  ContractError,
  defineMethod,
  defineService,
} from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type LeaseOutcome,
  type LeaseTask,
  RuntimeLeaseV1,
  runtimeLeaseMethods,
} from 'runtime/contracts';
import type { Sandbox } from 'sandbox';

import { createFilesReads } from '../src/client/api/reads.js';
import { FilesV1 } from '../src/contracts/index.js';
import { CONTENT_LIMIT_BYTES, filesService } from '../src/host/reads.js';
import { createFakeSandbox } from './fake-sandbox.js';

type LeaseState = 'ready' | 'pending' | 'unavailable' | 'expired' | 'missing';

/** The local sandbox with the bounded read the content route makes. */
const sandboxOver = (root: string): Sandbox => {
  const base = createFakeSandbox(root);
  return {
    ...base,
    exec: async (input) => {
      if (input.cmd[0] === 'head' && input.cmd[1] === '-c') {
        const limit = Number(input.cmd[2]);
        const path = input.cmd[4] as string;
        const bytes = await readFile(join(root, path)).catch(() => undefined);
        if (bytes === undefined)
          return {
            exitCode: 1,
            stdout: '',
            stderr: 'No such file',
            stdoutBytes: Buffer.alloc(0),
            stderrBytes: Buffer.alloc(0),
          };
        const out = bytes.subarray(0, limit);
        return {
          exitCode: 0,
          stdout: out.toString('utf8'),
          stderr: '',
          stdoutBytes: Buffer.from(out),
          stderrBytes: Buffer.alloc(0),
        };
      }
      return base.exec(input);
    },
  };
};

interface Lease {
  state: LeaseState;
  /** Closing starts, or the lease drops, while the task runs. */
  dropDuringTask: boolean;
  /** The Projects the reads asked the lease for. */
  readonly scopes: (string | undefined)[];
  /** A failure of the call itself (a lost bridge). */
  failure?: Error;
}

const fakeLease = (sandbox: Sandbox, lease: Lease) =>
  defineService(RuntimeLeaseV1.id, {
    withLease: defineMethod({
      ...runtimeLeaseMethods.withLease,
      execute: async (task: LeaseTask<unknown>, call) => {
        lease.scopes.push(call.scope?.projectId);
        if (lease.failure !== undefined) throw lease.failure;
        if (lease.state !== 'ready') return { status: lease.state };
        const value = await task(sandbox);
        const outcome: LeaseOutcome<unknown> = lease.dropDuringTask
          ? { status: 'unavailable' }
          : { status: 'ready', value };
        return outcome;
      },
    }),
  });

let root: string;

const write = async (path: string, content: string | Uint8Array) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'files-reads-'));
  await write('README.md', 'hello');
  await write('src/a.ts', 'export const a = 1;\n');
  await write('src/deep/b.ts', 'b');
  await write('image.bin', Uint8Array.from([0x89, 0x50, 0x00, 0x47]));
  await write('big.txt', 'x'.repeat(CONTENT_LIMIT_BYTES + 10));
  await write('exact.txt', 'y'.repeat(CONTENT_LIMIT_BYTES));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

const setup = (state: LeaseState = 'ready') => {
  const lease: Lease = { state, dropDuringTask: false, scopes: [] };
  const harness = createTestServices({
    bundle: { id: 'files-client' },
    provide: [filesService, fakeLease(sandboxOver(root), lease)],
  });
  const files = (scope: CallScope) => harness.services.use(FilesV1, scope);
  return {
    lease,
    files,
    reads: createFilesReads((projectId) => files({ projectId })),
    dispose: harness.dispose,
  };
};

describe('files/v1 over the Project lease', () => {
  test('lists the whole tree below a directory, and one level of it', async (t) => {
    const { files, lease, dispose } = setup();
    t.after(dispose);

    assert.deepEqual(await files({ projectId: 'p-1' }).tree({ path: 'src' }), {
      status: 'ready',
      value: {
        status: 'listed',
        path: 'src',
        entries: [
          {
            name: 'deep',
            path: 'src/deep',
            type: 'directory',
            children: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
          },
          { name: 'a.ts', path: 'src/a.ts', type: 'file' },
        ],
      },
    });
    const listing = await files({ projectId: 'p-1' }).directory({
      path: 'src',
    });
    assert.equal(listing.status, 'ready');
    if (listing.status !== 'ready' || listing.value.status !== 'listed')
      throw new Error('expected a listing');
    assert.deepEqual(
      listing.value.entries.map(({ path, type }) => [path, type]),
      [
        ['src/deep', 'directory'],
        ['src/a.ts', 'file'],
      ],
    );
    // The reads name the calling Project, which is the lease they run on.
    assert.deepEqual(lease.scopes, ['p-1', 'p-1']);
  });

  test('refuses a path that is missing, not a directory or outside the workspace', async (t) => {
    const { files, dispose } = setup();
    t.after(dispose);
    const project = files({ projectId: 'p-1' });

    assert.deepEqual(await project.tree({ path: 'nope' }), {
      status: 'ready',
      value: { status: 'not_found' },
    });
    assert.deepEqual(await project.directory({ path: 'README.md' }), {
      status: 'ready',
      value: { status: 'not_directory' },
    });
    assert.deepEqual(await project.tree({ path: '../outside' }), {
      status: 'ready',
      value: { status: 'invalid_path' },
    });
  });

  test('reads a file as text, cut at 256 KiB, and never shows a binary', async (t) => {
    const { files, dispose } = setup();
    t.after(dispose);
    const project = files({ projectId: 'p-1' });

    assert.deepEqual(await project.content({ path: 'src/a.ts' }), {
      status: 'ready',
      value: {
        status: 'read',
        path: 'src/a.ts',
        content: 'export const a = 1;\n',
        truncated: false,
        binary: false,
      },
    });
    const big = await project.content({ path: 'big.txt' });
    assert.ok(big.status === 'ready' && big.value.status === 'read');
    assert.equal(big.value.truncated, true);
    assert.equal(big.value.content.length, CONTENT_LIMIT_BYTES);
    const exact = await project.content({ path: 'exact.txt' });
    assert.ok(exact.status === 'ready' && exact.value.status === 'read');
    assert.equal(exact.value.truncated, false);
    const image = await project.content({ path: 'image.bin' });
    assert.ok(image.status === 'ready' && image.value.status === 'read');
    assert.equal(image.value.binary, true);
    assert.equal(image.value.content, '');
  });

  test('refuses a content read of a directory, a missing file or an outside path', async (t) => {
    const { files, dispose } = setup();
    t.after(dispose);
    const project = files({ projectId: 'p-1' });

    assert.deepEqual(await project.content({ path: 'src' }), {
      status: 'ready',
      value: { status: 'not_file' },
    });
    assert.deepEqual(await project.content({ path: 'gone.txt' }), {
      status: 'ready',
      value: { status: 'not_found' },
    });
    assert.deepEqual(await project.content({ path: '../etc/passwd' }), {
      status: 'ready',
      value: { status: 'invalid_path' },
    });
  });

  for (const state of [
    'pending',
    'unavailable',
    'expired',
    'missing',
  ] as const) {
    test(`answers a ${state} lease as data for every read`, async (t) => {
      const { files, dispose } = setup(state);
      t.after(dispose);
      const project = files({ projectId: 'p-1' });

      assert.deepEqual(await project.tree({}), { status: state });
      assert.deepEqual(await project.directory({}), { status: state });
      assert.deepEqual(await project.content({ path: 'README.md' }), {
        status: state,
      });
    });
  }

  test('a lease that drops while the read runs answers unavailable', async (t) => {
    const { files, lease, dispose } = setup();
    t.after(dispose);
    lease.dropDuringTask = true;

    assert.deepEqual(await files({ projectId: 'p-1' }).tree({}), {
      status: 'unavailable',
    });
  });
});

describe('the window reads over files/v1', () => {
  test('a ready tree and file arrive as the REST client read them', async (t) => {
    const { reads, dispose } = setup();
    t.after(dispose);

    const tree = await reads.tree('p-1', 'src/deep');
    assert.deepEqual(tree, {
      status: 'ready',
      path: 'src/deep',
      entries: [{ name: 'b.ts', path: 'src/deep/b.ts', type: 'file' }],
    });
    assert.deepEqual(await reads.file('p-1', 'README.md'), {
      status: 'ready',
      file: {
        path: 'README.md',
        content: 'hello',
        truncated: false,
        binary: false,
      },
    });
  });

  test('a pending lease carries the one-second retry hint; other states pass through', async (t) => {
    const pending = setup('pending');
    t.after(pending.dispose);
    assert.deepEqual(await pending.reads.tree('p-1'), {
      status: 'pending',
      retryAfterSeconds: 1,
    });
    const expired = setup('expired');
    t.after(expired.dispose);
    assert.deepEqual(await expired.reads.file('p-1', 'README.md'), {
      status: 'expired',
    });
  });

  test('a missing path is not_found and every other refusal is invalid_path', async (t) => {
    const { reads, dispose } = setup();
    t.after(dispose);

    assert.deepEqual(await reads.tree('p-1', 'nope'), { status: 'not_found' });
    assert.deepEqual(await reads.tree('p-1', 'README.md'), {
      status: 'invalid_path',
    });
    assert.deepEqual(await reads.file('p-1', 'src'), {
      status: 'invalid_path',
    });
    // The content route required a path; the workspace root sent none.
    assert.deepEqual(await reads.file('p-1', ''), { status: 'invalid_path' });
  });

  test('the payload guards refuse before calling the host', async (t) => {
    const { reads, lease, dispose } = setup();
    t.after(dispose);

    await assert.rejects(reads.tree('', 'src'), {
      message: 'The item identifier is invalid.',
    });
    await assert.rejects(reads.tree('p-1', '../up'), {
      message: 'The workspace path is invalid.',
    });
    await assert.rejects(reads.file('p-1', '/etc/passwd'), {
      message: 'The workspace path is invalid.',
    });
    assert.deepEqual(lease.scopes, []);
  });

  test('a lost backend reads as unavailable, any other failure as the generic sentence', async (t) => {
    const { reads, lease, dispose } = setup();
    t.after(dispose);

    lease.failure = new ContractError('disconnected', 'Bridge closed.');
    await assert.rejects(reads.tree('p-1'), {
      message: 'Doric backend is unavailable.',
    });
    lease.failure = new Error('boom');
    await assert.rejects(reads.file('p-1', 'README.md'), {
      message: 'The request could not be completed.',
    });
  });
});
