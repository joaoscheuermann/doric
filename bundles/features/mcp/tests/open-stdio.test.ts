// S59a: `openStdio` over an `McpLease` (D4), the port both the kernel's
// `withLease` and the process's `runtime.lease/v1.Start` implement: which
// Project it runs on, what the process receives, and what each lease outcome
// and start failure reads as.

import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

import { ContractError } from 'bundle/contracts';
import type { LeaseOutcome } from 'runtime/contracts';
import type { SandboxProcess, SandboxProcessInput } from 'sandbox';

import type { McpTransport } from '../src/contracts/index.js';
import type { ResolvedEntries } from '../src/host/credentials.js';
import { openStdio } from '../src/host/open.js';
import type { McpLease, McpSandbox } from '../src/host/ports.js';
import { type FakeSandbox, fakeSandbox } from './support/sandbox.js';
import { P1 } from './support/world.js';

type Stdio = Extract<McpTransport, { readonly kind: 'stdio' }>;

const transport: Stdio = {
  kind: 'stdio',
  command: 'node',
  args: ['server.js', '--stdio'],
  cwd: '/workspace/tools',
  env: [],
};

const entries: ResolvedEntries = {
  values: { MODE: 'test', TOKEN: 'secret-o1' },
  secrets: ['secret-o1'],
};

const CANNOT_KEEP =
  'The Project sandbox cannot keep a process running, so it cannot run a stdio MCP server.';
const NO_PROJECT =
  'The Project no longer exists, so its stdio MCP server cannot start.';
const ENDED =
  'The Project has ended, so its sandbox cannot run a stdio MCP server.';

type Answer = LeaseOutcome<unknown>['status'] | 'lost';

/**
 * A lease over `sandbox`: `ready` runs the task and answers its value; `lost`
 * runs it and then answers `unavailable` (the lease dropped meanwhile); any
 * other status answers without running it. Records each run's Project.
 */
const leaseOf = (answer: Answer, sandbox: McpSandbox) => {
  const runs: string[] = [];
  const lease: McpLease = {
    run: async <T>(
      projectId: string,
      task: (sandbox: McpSandbox) => Promise<T>,
    ): Promise<LeaseOutcome<T>> => {
      runs.push(projectId);

      if (answer === 'ready') {
        return { status: 'ready', value: await task(sandbox) };
      }

      if (answer === 'lost') {
        await task(sandbox);
        return { status: 'unavailable' };
      }

      if (answer === 'pending' || answer === 'unavailable') {
        return { status: answer };
      }

      return { status: answer as 'expired' | 'missing' };
    },
  };

  return { lease, runs };
};

/** A sandbox whose `start` runs the fake's in-process server. */
const startable = (fake: FakeSandbox): McpSandbox => ({
  start: (input: SandboxProcessInput): Promise<SandboxProcess> => {
    const start = fake.sandbox.start;
    assert.ok(start !== undefined);

    return start(input);
  },
});

const open = (lease: McpLease, signal = new AbortController().signal) =>
  openStdio(transport, entries, P1, lease, () => undefined, signal);

const closing = (t: TestContext, opened: Awaited<ReturnType<typeof open>>) => {
  if (opened.kind === 'open') {
    t.after(() => opened.client.close());
  }
};

void test('S59a O1 a ready lease of the Project starts the command with its cwd and entries, without a tty, and answers a connected client', async (t) => {
  const fake = fakeSandbox();
  const { lease, runs } = leaseOf('ready', startable(fake));

  const opened = await open(lease);
  closing(t, opened);

  assert.deepEqual(runs, [P1]);

  assert.equal(opened.kind, 'open');

  assert.equal(fake.started.length, 1);

  const [process] = fake.started;

  assert.deepEqual(process?.input.cmd, ['node', 'server.js', '--stdio']);

  assert.equal(process?.input.cwd, '/workspace/tools');

  assert.deepEqual([...(process?.input.env ?? [])].sort(), [
    'MODE=test',
    'TOKEN=secret-o1',
  ]);

  assert.equal(process?.input.tty, false);

  assert.ok(opened.kind === 'open');

  const listed = await opened.client.listTools();

  assert.deepEqual(
    listed.tools.map((tool) => tool.name),
    ['echo'],
  );
});

void test('S59a O2 a sandbox without start rejects with the text that it cannot keep a process running', async () => {
  const { lease } = leaseOf('ready', {});

  await assert.rejects(open(lease), (error: unknown) => {
    assert.equal((error as Error).message, CANNOT_KEEP);
    return true;
  });
});

void test('S59a O3 a start refused with unsupported_operation reads as the same text', async () => {
  const { lease } = leaseOf('ready', {
    start: () =>
      Promise.reject(
        new ContractError(
          'unsupported_operation',
          'This sandbox cannot start processes.',
        ),
      ),
  });

  await assert.rejects(open(lease), (error: unknown) => {
    assert.equal((error as Error).message, CANNOT_KEEP);
    return true;
  });
});

void test('S59a O4 a missing Project and an ended one reject with their two texts', async () => {
  const fake = fakeSandbox();

  await assert.rejects(
    open(leaseOf('missing', startable(fake)).lease),
    (error: unknown) => {
      assert.equal((error as Error).message, NO_PROJECT);
      return true;
    },
  );

  await assert.rejects(
    open(leaseOf('expired', startable(fake)).lease),
    (error: unknown) => {
      assert.equal((error as Error).message, ENDED);
      return true;
    },
  );

  assert.equal(fake.started.length, 0);
});

void test('S59a O5 a pending or unavailable lease answers waiting, and a lease lost while starting ends the started process', async () => {
  const fake = fakeSandbox();

  assert.deepEqual(await open(leaseOf('pending', startable(fake)).lease), {
    kind: 'waiting',
  });

  assert.deepEqual(await open(leaseOf('unavailable', startable(fake)).lease), {
    kind: 'waiting',
  });

  assert.equal(fake.started.length, 0);

  assert.deepEqual(await open(leaseOf('lost', startable(fake)).lease), {
    kind: 'waiting',
  });

  assert.equal(fake.started.length, 1);

  assert.equal(fake.started[0]?.terminated, true);
});

void test('S59a O6 any other lease failure propagates', async () => {
  const failure = new ContractError('internal', 'The runtime failed.');
  const lease: McpLease = { run: () => Promise.reject(failure) };

  await assert.rejects(open(lease), (error: unknown) => error === failure);
});
