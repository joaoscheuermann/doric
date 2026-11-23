// S57 D1: the kernel's `PapercraftPorts`, each method today's
// `services.use(...)` call, over a services stub that records the contract,
// scope and request of every call.
//
// Contract matrix:
// - `files.content`: `files/v1.content({path})` under the call's scope, or
//   `{projectId}` without a call;
// - `files.readBytes`: `content({path, encoding: 'base64'})` decoded into
//   `{status: 'read', bytes, truncated}`; other read states and lease
//   states pass through;
// - `lease.run`: `runtime.lease/v1.withLease(task)` under `{projectId}`;
// - `threads.eventsAfter`: `threadEvents({id, afterSequence})` as `{events,
//   lastSequence}`; no log → `undefined`;
// - `threads.instruct`: `runtime.threads/v1.instruct(input)`;
// - `appendCwd`: `events/v1.append(cwdEvent, {cwd})` under `{projectId,
//   threadId, promptId}`.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Call, Services } from 'bundle/contracts';

import { cwdEvent } from '../src/contracts/index.js';
import { kernelPapercraftPorts } from '../src/host/ports.js';
import type { RunnerSandbox } from '../src/host/sandbox.js';

const call = {
  scope: { projectId: 'p1', threadId: 't1', promptId: 'q1' },
} as unknown as Call;

interface Use {
  readonly id: string;
  readonly scope: unknown;
  readonly method: string;
  readonly args: readonly unknown[];
}

/** Services whose `use(contract, scope)` answers `apis[id]`, recording each method call. */
const servicesOver = (
  apis: Readonly<Record<string, Record<string, (...args: never[]) => unknown>>>,
): Services & { readonly uses: Use[] } => {
  const uses: Use[] = [];

  return {
    uses,
    provide: () => ({ dispose: () => undefined }),
    whenAvailable: () => ({ dispose: () => undefined }),
    use: (contract: { readonly id?: string }, scope?: unknown) => {
      const id = contract.id ?? '';
      const api = apis[id];
      if (api === undefined) throw new Error(`unexpected contract ${id}`);

      return new Proxy(api, {
        get: (target, method: string) => {
          const fn = target[method];
          if (fn === undefined) throw new Error(`unexpected ${id}.${method}`);

          return (...args: never[]) => {
            uses.push({ id, scope, method, args });
            return fn(...args);
          };
        },
      });
    },
  } as unknown as Services & { readonly uses: Use[] };
};

const readOf = (content: string) => ({
  status: 'ready',
  value: {
    status: 'read',
    path: 'x',
    content,
    truncated: false,
    binary: false,
  },
});

describe('kernelPapercraftPorts', () => {
  describe('files', () => {
    test("content reads files/v1 under the call's scope", async () => {
      const services = servicesOver({
        'files/v1': { content: () => Promise.resolve(readOf('hello')) },
      });

      const outcome = await kernelPapercraftPorts(services).files.content(
        'src/a.ts',
        { projectId: 'p1', call },
      );

      assert.deepEqual(outcome, readOf('hello'));
      assert.equal(services.uses.length, 1);
      assert.deepEqual(services.uses[0]?.scope, call.scope);
      assert.deepEqual(services.uses[0]?.args[0], { path: 'src/a.ts' });
    });

    test('content reads under {projectId} when there is no call', async () => {
      const services = servicesOver({
        'files/v1': { content: () => Promise.resolve(readOf('hello')) },
      });

      await kernelPapercraftPorts(services).files.content('src/a.ts', {
        projectId: 'p2',
      });

      assert.deepEqual(services.uses[0]?.scope, { projectId: 'p2' });
    });

    test('readBytes decodes the base64 content into the file bytes', async () => {
      const bytes = Buffer.from([0, 1, 2, 250, 255]);
      const services = servicesOver({
        'files/v1': {
          content: () =>
            Promise.resolve({
              status: 'ready',
              value: {
                status: 'read',
                path: 'font.woff2',
                content: bytes.toString('base64'),
                truncated: false,
                binary: true,
              },
            }),
        },
      });

      const outcome = await kernelPapercraftPorts(services).files.readBytes(
        'font.woff2',
        { projectId: 'p1', call },
      );

      assert.deepEqual(services.uses[0]?.args[0], {
        path: 'font.woff2',
        encoding: 'base64',
      });
      assert.equal(outcome.status, 'ready');
      assert.ok(outcome.status === 'ready' && outcome.value.status === 'read');
      assert.deepEqual(Buffer.from(outcome.value.bytes), bytes);
      assert.equal(outcome.value.truncated, false);
    });

    test('readBytes passes a missing file and a lease state through', async () => {
      const missing = servicesOver({
        'files/v1': {
          content: () =>
            Promise.resolve({
              status: 'ready',
              value: { status: 'not_found' },
            }),
        },
      });
      const pending = servicesOver({
        'files/v1': { content: () => Promise.resolve({ status: 'pending' }) },
      });

      assert.deepEqual(
        await kernelPapercraftPorts(missing).files.readBytes('x', {
          projectId: 'p1',
        }),
        { status: 'ready', value: { status: 'not_found' } },
      );
      assert.deepEqual(
        await kernelPapercraftPorts(pending).files.readBytes('x', {
          projectId: 'p1',
        }),
        { status: 'pending' },
      );
    });
  });

  test("lease.run runs the task through withLease under the Project's scope", async () => {
    const sandbox = { id: 's1', root: '/w' } as unknown as RunnerSandbox;
    const services = servicesOver({
      'runtime.lease/v1': {
        withLease: async (
          task: (sandbox: RunnerSandbox) => Promise<unknown>,
        ) => ({
          status: 'ready',
          value: await task(sandbox),
        }),
      },
    });

    const outcome = await kernelPapercraftPorts(services).lease.run(
      'p1',
      (given) => Promise.resolve(given.id),
    );

    assert.deepEqual(outcome, { status: 'ready', value: 's1' });
    assert.deepEqual(services.uses[0]?.scope, { projectId: 'p1' });
  });

  describe('threads', () => {
    test('eventsAfter answers the rows after the cursor and the last sequence', async () => {
      const services = servicesOver({
        'runtime.threads/v1': {
          threadEvents: () =>
            Promise.resolve({
              events: [
                {
                  sequence: 4,
                  type: 'papercraft.cwd/v1',
                  event: { cwd: '/w' },
                  createdAt: '2026-11-23T00:00:00.000Z',
                },
              ],
              lastSequence: 9,
            }),
        },
      });

      const log = await kernelPapercraftPorts(services).threads.eventsAfter(
        't1',
        3,
      );

      assert.deepEqual(services.uses[0]?.args[0], {
        id: 't1',
        afterSequence: 3,
      });
      assert.deepEqual(
        log === undefined
          ? undefined
          : {
              events: log.events.map(({ sequence, type, event }) => ({
                sequence,
                type,
                event,
              })),
              lastSequence: log.lastSequence,
            },
        {
          events: [
            { sequence: 4, type: 'papercraft.cwd/v1', event: { cwd: '/w' } },
          ],
          lastSequence: 9,
        },
      );
    });

    test('eventsAfter answers undefined when the Thread has no log', async () => {
      const services = servicesOver({
        'runtime.threads/v1': {
          threadEvents: () => Promise.resolve(undefined),
        },
      });

      assert.equal(
        await kernelPapercraftPorts(services).threads.eventsAfter('t1', 0),
        undefined,
      );
    });

    test("instruct gives runtime.threads/v1's instruct and answers its result", async () => {
      const services = servicesOver({
        'runtime.threads/v1': {
          instruct: () =>
            Promise.resolve({ status: 'steered', promptId: 'q1' }),
        },
      });
      const input = {
        id: 't1',
        prompt: 'The repository library could not be checked: boom',
        reason: 'library',
        promptId: 'q1',
        retain: true,
      } as const;

      const result = await kernelPapercraftPorts(services).threads.instruct(
        input,
        call,
      );

      assert.deepEqual(result, { status: 'steered', promptId: 'q1' });
      assert.deepEqual(services.uses[0]?.args[0], input);
    });
  });

  test('appendCwd appends papercraft.cwd/v1 under the prompt scope', async () => {
    const services = servicesOver({
      'events/v1': { append: () => Promise.resolve(undefined) },
    });

    await kernelPapercraftPorts(services).appendCwd(
      { projectId: 'p1', threadId: 't1', promptId: 'q1' },
      '/w/app',
      call,
    );

    assert.equal(services.uses.length, 1);
    assert.deepEqual(services.uses[0]?.scope, {
      projectId: 'p1',
      threadId: 't1',
      promptId: 'q1',
    });
    assert.equal(services.uses[0]?.args[0], cwdEvent);
    assert.deepEqual(services.uses[0]?.args[1], { cwd: '/w/app' });
  });
});
