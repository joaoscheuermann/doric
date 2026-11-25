// The window's terminal stream over `terminal/v1.watchProject`, from slice
// S65d: `terminalStreamsOf` reads the generated `WatchProjectResponse` oneofs
// back into today's `TerminalWatchItem`s, and the stream carries the Project's
// scope. The four items are the four messages the host sends: the snapshot
// first, then updates, removals and live output (`terminalOneofs`).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { Disposable } from 'bundle/contracts';

import { terminalStreamsOf } from '../src/client/stream-source.js';
import { TerminalService } from '../src/contracts/gen/doric/terminal/v1/terminal_pb.js';
import type { TerminalWatchItem } from '../src/contracts/index.js';
import { connectFailure, settle, until } from './support/connect.js';
import {
  sessionOf,
  type TerminalHost,
  terminalWindow,
} from './support/terminal-connect.js';

const session = (
  overrides: Partial<Parameters<typeof sessionOf>[0]> = {},
): ReturnType<typeof sessionOf> =>
  sessionOf({
    id: 'terminal-1',
    projectId: 'project-1',
    threadId: 'thread-1',
    origin: 'user',
    command: 'bash',
    cwd: '/workspace',
    startedAt: '2026-01-01T00:00:00.000Z',
    timeoutMs: null,
    state: 'running',
    pty: true,
    ...overrides,
  });

/** The opened request as today's input. */
const input = (request: { readonly projectId: string }) => ({
  projectId: request.projectId,
});

/** A host that answers nothing: these tests read the stream only. */
const host: TerminalHost = {
  list: async () => [],
  create: async () => undefined,
  snapshot: async () => undefined,
  input: async () => false,
  resize: async () => false,
  stop: async () => false,
  rename: async () => false,
};

describe('the window terminal stream over terminal/v1', () => {
  test('the snapshot, update, removal and output messages arrive as today’s items', async () => {
    const { services, stream } = terminalWindow(() => host);
    const source = terminalStreamsOf((projectId) =>
      services.use(TerminalService, { projectId }),
    );
    const items: TerminalWatchItem[] = [];
    const ended: unknown[] = [];

    const stop: Disposable = source.watchProject('project-1', {
      next: (item) => void items.push(item),
      end: (error) => void ended.push(error),
    });

    await until(() => stream.openings.length === 1, 'the watch to open');
    const opening = stream.latest();

    assert.deepEqual(input(opening.request), { projectId: 'project-1' });
    assert.deepEqual(opening.scope, { projectId: 'project-1' });

    opening.push({
      item: {
        case: 'snapshot',
        value: { projectId: 'project-1', terminals: [session()] },
      },
    });
    opening.push({
      item: {
        case: 'updated',
        value: session({ id: 'terminal-1', command: 'npm run dev' }),
      },
    });
    opening.push({
      item: {
        case: 'removed',
        value: {
          projectId: 'project-1',
          threadId: 'thread-1',
          terminalId: 'terminal-2',
        },
      },
    });
    opening.push({
      item: {
        case: 'output',
        value: {
          projectId: 'project-1',
          threadId: 'thread-1',
          terminalId: 'terminal-1',
          data: 'hello',
          offset: 5,
        },
      },
    });

    await until(() => items.length === 4, 'the four items');

    assert.deepEqual(items, [
      {
        kind: 'snapshot',
        projectId: 'project-1',
        terminals: [
          {
            id: 'terminal-1',
            projectId: 'project-1',
            threadId: 'thread-1',
            origin: 'user',
            command: 'bash',
            cwd: '/workspace',
            startedAt: '2026-01-01T00:00:00.000Z',
            timeoutMs: null,
            state: 'running',
            pty: true,
          },
        ],
      },
      {
        kind: 'updated',
        terminal: {
          id: 'terminal-1',
          projectId: 'project-1',
          threadId: 'thread-1',
          origin: 'user',
          command: 'npm run dev',
          cwd: '/workspace',
          startedAt: '2026-01-01T00:00:00.000Z',
          timeoutMs: null,
          state: 'running',
          pty: true,
        },
      },
      {
        kind: 'removed',
        projectId: 'project-1',
        threadId: 'thread-1',
        terminalId: 'terminal-2',
      },
      {
        kind: 'output',
        output: {
          projectId: 'project-1',
          threadId: 'thread-1',
          terminalId: 'terminal-1',
          data: 'hello',
          offset: 5,
        },
      },
    ]);
    assert.deepEqual(ended, []);

    stop.dispose();
    await settle();
    assert.equal(stream.latest().closed, true);
  });

  test('a session the host sends without a name carries none, and one it names carries it', async () => {
    const { services, stream } = terminalWindow(() => host);
    const source = terminalStreamsOf((projectId) =>
      services.use(TerminalService, { projectId }),
    );
    const items: TerminalWatchItem[] = [];

    const stop = source.watchProject('project-1', {
      next: (item) => void items.push(item),
    });
    await until(() => stream.openings.length === 1, 'the watch to open');

    stream.latest().push({
      item: {
        case: 'updated',
        value: session({ id: 'manual-1', name: 'dev' }),
      },
    });
    await until(() => items.length === 1, 'the update');

    assert.deepEqual(items[0], {
      kind: 'updated',
      terminal: {
        id: 'manual-1',
        projectId: 'project-1',
        threadId: 'thread-1',
        origin: 'user',
        command: 'bash',
        cwd: '/workspace',
        startedAt: '2026-01-01T00:00:00.000Z',
        timeoutMs: null,
        state: 'running',
        pty: true,
        name: 'dev',
      },
    });
    stop.dispose();
  });

  test('a stream the host fails ends with its Doric error, and no other item follows', async () => {
    const { services, stream } = terminalWindow(() => host);
    const source = terminalStreamsOf((projectId) =>
      services.use(TerminalService, { projectId }),
    );
    const items: TerminalWatchItem[] = [];
    const ended: unknown[] = [];

    const stop = source.watchProject('project-1', {
      next: (item) => void items.push(item),
      end: (error) => void ended.push(error),
    });
    await until(() => stream.openings.length === 1, 'the watch to open');

    stream
      .latest()
      .end(connectFailure({ code: 'unavailable', message: 'gone' }));
    await until(() => ended.length === 1, 'the stream to end');

    assert.deepEqual(items, []);
    assert.equal((ended[0] as { code?: string }).code, 'unavailable');
    stop.dispose();
  });
});
