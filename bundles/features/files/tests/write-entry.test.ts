// files/v1@1.2.0 New file and New folder (ui-redesign §4.4, T-4.4.2): one
// single-segment name in an existing workspace directory, created by one
// command that never overwrites. The sandbox is a local directory standing
// for `/workspace`: commands run there for real, with every `/workspace` path
// argument mapped onto it, and a test may step in before the create command.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { defineMethod, defineService, isContractError } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';
import {
  type LeaseOutcome,
  type LeaseTask,
  RuntimeLeaseV1,
  runtimeLeaseMethods,
} from 'runtime/contracts';
import type { Sandbox, SandboxExecInput, SandboxExecResult } from 'sandbox';

import { FilesV1 } from '../src/contracts/index.js';
import { filesService } from '../src/host/reads.js';
import { createEntry } from '../src/host/writes.js';
import { createFakeSandbox, WORKSPACE_ROOT } from './fake-sandbox.js';

const run = promisify(execFile);

/** Answers a command in place of the sandbox, or lets it run (undefined). */
type Intercept = (
  input: SandboxExecInput,
  local: (path: string) => string,
) => Promise<SandboxExecResult | undefined>;

/** A `/workspace` sandbox over a local directory; commands run for real. */
const localSandbox = (localRoot: string, intercept?: Intercept): Sandbox => {
  const local = (value: string): string =>
    value === WORKSPACE_ROOT
      ? localRoot
      : value.startsWith(`${WORKSPACE_ROOT}/`)
        ? join(localRoot, value.slice(WORKSPACE_ROOT.length + 1))
        : value;

  return {
    ...createFakeSandbox(localRoot),
    exec: async (input) => {
      const answer = await intercept?.(input, local);
      if (answer !== undefined) return answer;
      const [command = '', ...args] = input.cmd.map(local);
      try {
        const done = await run(command, args, {
          cwd: local(input.cwd ?? WORKSPACE_ROOT),
          encoding: 'buffer',
        });
        return outcome(0, done.stdout, done.stderr);
      } catch (error) {
        const failed = error as {
          code?: number;
          stdout?: Buffer;
          stderr?: Buffer;
        };
        return outcome(
          typeof failed.code === 'number' ? failed.code : 1,
          failed.stdout ?? Buffer.alloc(0),
          failed.stderr ?? Buffer.alloc(0),
        );
      }
    },
  };
};

const outcome = (
  exitCode: number,
  stdout: Buffer,
  stderr: Buffer,
): SandboxExecResult => ({
  exitCode,
  stdout: stdout.toString(),
  stderr: stderr.toString(),
  stdoutBytes: stdout,
  stderrBytes: stderr,
});

/** Whether a command is the one that makes the entry (not a kind check). */
const isCreate = (input: SandboxExecInput): boolean =>
  input.cmd[0] === 'mkdir' ||
  (input.cmd[0] === 'sh' && (input.cmd[2] ?? '').includes('set -C'));

let root: string;

/** Every entry under the local root, with each file's content. */
const snapshot = async (): Promise<Record<string, string | null>> => {
  const entries: Record<string, string | null> = {};
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), {
      withFileTypes: true,
    })) {
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        entries[path] = null;
        await walk(path);
      } else entries[path] = await readFile(join(root, path), 'utf8');
    }
  };
  await walk('');
  return entries;
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'files-writes-'));
  await mkdir(join(root, 'src', 'lib'), { recursive: true });
  await writeFile(join(root, 'README.md'), 'hello');
  await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const kinds = ['file', 'directory'] as const;

describe('createEntry', () => {
  for (const kind of kinds) {
    test(`creates an empty ${kind} and answers its workspace-relative path`, async () => {
      const sandbox = localSandbox(root);

      assert.deepEqual(
        await createEntry(sandbox, { directory: 'src', name: 'new' }, kind),
        { status: 'created', path: 'src/new' },
      );
      const made = await stat(join(root, 'src', 'new'));
      if (kind === 'file') {
        assert.ok(made.isFile());
        assert.equal(made.size, 0);
      } else {
        assert.ok(made.isDirectory());
        assert.deepEqual(await readdir(join(root, 'src', 'new')), []);
      }

      assert.deepEqual(
        await createEntry(sandbox, { directory: '', name: 'top' }, kind),
        { status: 'created', path: 'top' },
      );
    });

    test(`resolves an absolute directory once for a ${kind}`, async () => {
      assert.deepEqual(
        await createEntry(
          localSandbox(root),
          { directory: '/workspace/src', name: 'abs' },
          kind,
        ),
        { status: 'created', path: 'src/abs' },
      );
      await stat(join(root, 'src', 'abs'));
    });

    test(`refuses a ${kind} whose name exists and leaves it unchanged`, async () => {
      const sandbox = localSandbox(root);
      const before = await snapshot();

      for (const name of ['a.ts', 'lib']) {
        assert.deepEqual(
          await createEntry(sandbox, { directory: 'src', name }, kind),
          { status: 'refused', reason: 'exists' },
          name,
        );
      }
      assert.deepEqual(await snapshot(), before);
    });

    test(`refuses an invalid ${kind} name and writes nothing`, async () => {
      const sandbox = localSandbox(root);
      const before = await snapshot();

      for (const name of [
        '',
        'a/b',
        'a\\b',
        'a\0b',
        '.',
        '..',
        'x'.repeat(256),
        'é'.repeat(128),
      ]) {
        assert.deepEqual(
          await createEntry(sandbox, { directory: 'src', name }, kind),
          { status: 'refused', reason: 'invalid-name' },
          JSON.stringify(name),
        );
      }
      assert.deepEqual(await snapshot(), before);
    });

    test(`accepts a ${kind} name of 255 bytes`, async () => {
      const name = 'x'.repeat(255);
      assert.deepEqual(
        await createEntry(localSandbox(root), { directory: 'src', name }, kind),
        { status: 'created', path: `src/${name}` },
      );
    });

    test(`refuses a ${kind} in a directory outside the sandbox`, async () => {
      const sandbox = localSandbox(root);
      const before = await snapshot();

      for (const directory of ['..', '../outside', '/etc', 'src/../..']) {
        assert.deepEqual(
          await createEntry(sandbox, { directory, name: 'x' }, kind),
          { status: 'refused', reason: 'outside' },
          directory,
        );
      }
      assert.deepEqual(await snapshot(), before);
    });

    test(`refuses a ${kind} in a missing directory or in a file`, async () => {
      const sandbox = localSandbox(root);
      const before = await snapshot();

      for (const directory of ['nope', 'src/nope', 'README.md', 'src/a.ts']) {
        assert.deepEqual(
          await createEntry(sandbox, { directory, name: 'x' }, kind),
          { status: 'refused', reason: 'no-directory' },
          directory,
        );
      }
      assert.deepEqual(await snapshot(), before);
    });

    test(`answers exists when the ${kind} name appears before the command`, async () => {
      // Another writer makes the name between the checks and the create.
      const sandbox = localSandbox(root, async (input) => {
        if (isCreate(input))
          await writeFile(join(root, 'src', 'raced'), 'theirs');
        return undefined;
      });

      assert.deepEqual(
        await createEntry(sandbox, { directory: 'src', name: 'raced' }, kind),
        { status: 'refused', reason: 'exists' },
      );
      assert.equal(
        await readFile(join(root, 'src', 'raced'), 'utf8'),
        'theirs',
      );
    });

    test(`answers failed with the first stderr line when the ${kind} command fails`, async () => {
      const sandbox = localSandbox(root, async (input) =>
        isCreate(input)
          ? outcome(
              1,
              Buffer.alloc(0),
              Buffer.from(
                'cannot create /workspace/src/x: Read-only file system\nsecond line\n',
              ),
            )
          : undefined,
      );
      const before = await snapshot();

      assert.deepEqual(
        await createEntry(sandbox, { directory: 'src', name: 'x' }, kind),
        {
          status: 'failed',
          message: 'cannot create /workspace/src/x: Read-only file system',
        },
      );
      assert.deepEqual(await snapshot(), before);
    });
  }

  test('creates through the sandbox command, never a write that overwrites', async () => {
    const commands: string[][] = [];
    const sandbox = localSandbox(root, async (input) => {
      commands.push([...input.cmd]);
      return undefined;
    });

    await createEntry(sandbox, { directory: 'src', name: 'f' }, 'file');
    await createEntry(sandbox, { directory: 'src', name: 'd' }, 'directory');

    const creates = commands.filter((cmd) => isCreate({ cmd }));
    assert.deepEqual(creates, [
      ['sh', '-c', 'set -C; : > "$1"', 'sh', '/workspace/src/f'],
      ['mkdir', '--', '/workspace/src/d'],
    ]);
  });
});

const fakeLease = (sandbox: Sandbox, state: LeaseOutcome<unknown>['status']) =>
  defineService(RuntimeLeaseV1.id, {
    withLease: defineMethod({
      ...runtimeLeaseMethods.withLease,
      execute: async (
        task: LeaseTask<unknown>,
      ): Promise<LeaseOutcome<unknown>> =>
        state === 'ready'
          ? { status: 'ready', value: await task(sandbox) }
          : { status: state },
    }),
  });

describe('files/v1 createFile and createDirectory', () => {
  test('both methods are exposed to the desktop', () => {
    assert.equal(filesService.methods.createFile.expose, 'desktop');
    assert.equal(filesService.methods.createDirectory.expose, 'desktop');
  });

  test('run on the Project lease and answer its state', async (t) => {
    const ready = createTestServices({
      bundle: { id: 'files-client' },
      provide: [filesService, fakeLease(localSandbox(root), 'ready')],
    });
    t.after(ready.dispose);
    const files = ready.services.use(FilesV1, { projectId: 'p-1' });

    assert.deepEqual(await files.createFile({ directory: 'src', name: 'n' }), {
      status: 'ready',
      value: { status: 'created', path: 'src/n' },
    });
    assert.deepEqual(
      await files.createDirectory({ directory: 'src', name: 'm' }),
      { status: 'ready', value: { status: 'created', path: 'src/m' } },
    );

    const pending = createTestServices({
      bundle: { id: 'files-client' },
      provide: [filesService, fakeLease(localSandbox(root), 'pending')],
    });
    t.after(pending.dispose);
    assert.deepEqual(
      await pending.services
        .use(FilesV1, { projectId: 'p-1' })
        .createFile({ directory: 'src', name: 'later' }),
      { status: 'pending' },
    );
    await assert.rejects(stat(join(root, 'src', 'later')));
  });

  test('reject an extra input property with invalid_input', async (t) => {
    const harness = createTestServices({
      bundle: { id: 'files-client' },
      provide: [filesService, fakeLease(localSandbox(root), 'ready')],
    });
    t.after(harness.dispose);
    const files = harness.services.use(FilesV1, { projectId: 'p-1' });
    const extra = { directory: 'src', name: 'x', overwrite: true };

    await assert.rejects(
      async () => files.createFile(extra),
      (error) => isContractError(error) && error.code === 'invalid_input',
    );
    await assert.rejects(
      async () => files.createDirectory(extra),
      (error) => isContractError(error) && error.code === 'invalid_input',
    );
    await assert.rejects(stat(join(root, 'src', 'x')));
  });
});
