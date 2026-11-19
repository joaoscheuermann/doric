// Bundle isolation 5(c) change 3, T5.5: the chat no longer refreshes after a
// tool call. `files` hears `chat.hooks/v2`: `onSandboxActivityHook` for the
// lifecycle causes, and `onThreadUpdateHook`, from which it asks for a
// Project's refresh after a finished `edit` or `write` call, and after no
// other tool.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { HooksContract } from 'bundle/contracts';
import { createTestServices } from 'bundle/testing';

import { refreshAfterWrites } from '../../src/client/refresh/tool-refresh.js';
import { FilesRefreshV1 } from '../../src/contracts/index.js';
import { installWindow } from './support/render.js';

type Input = Parameters<ReturnType<typeof refreshAfterWrites>>[0];

/** A live event of Thread `thread-a` in `projectId`, its record as stored. */
const live = (projectId: string, type: string, name: string): Input =>
  ({
    projectId,
    threadId: 'thread-a',
    threadName: 'Fix the parser',
    update: {
      kind: 'event',
      event: {
        projectId,
        threadId: 'thread-a',
        promptId: 'prompt',
        sequence: 1,
        createdAt: '',
        type,
        event: {
          type,
          call: { id: 'call-1', name, arguments: '{}' },
          record: { output: 'ok' },
        },
      },
    },
  }) as Input;

const requests = (input: Input): string[] => {
  const asked: string[] = [];
  refreshAfterWrites((id) => asked.push(id))(input);
  return asked;
};

describe('refreshAfterWrites', () => {
  test('a finished edit or write requests its Project once', () => {
    assert.deepEqual(requests(live('project-a', 'tool.finished', 'edit')), [
      'project-a',
    ]);
    assert.deepEqual(requests(live('project-b', 'tool.finished', 'write')), [
      'project-b',
    ]);
  });

  test('a finished call of another tool requests nothing', () => {
    for (const name of ['view-image', 'tree', 'git', 'terminal'])
      assert.deepEqual(
        requests(live('project-a', 'tool.finished', name)),
        [],
        name,
      );
  });

  test('an edit that starts or fails requests nothing', () => {
    assert.deepEqual(requests(live('project-a', 'tool.started', 'edit')), []);
    assert.deepEqual(requests(live('project-a', 'tool.failed', 'edit')), []);
  });

  test('an updated Thread record requests nothing', () => {
    assert.deepEqual(
      requests({
        projectId: 'project-a',
        threadId: 'thread-a',
        threadName: 'Fix the parser',
        update: {
          kind: 'updated',
          thread: { id: 'thread-a', projectId: 'project-a', state: 'ready' },
        },
      } as Input),
      [],
    );
  });
});

/** What the activation registered on `hooks/v1`, by contract id and hook. */
interface Activation {
  readonly handlers: ReadonlyMap<string, (input: unknown) => unknown>;
  readonly disposed: readonly string[];
  /** The Projects whose registered reads were refreshed, in order. */
  readonly refreshed: readonly string[];
  readonly cleanup: () => void;
}

let activation: Activation | undefined;

afterEach(() => {
  activation?.cleanup();
  activation = undefined;
});

/**
 * Activates the files client part over fakes whose `hooks/v1` serves every
 * hooks contract at once and records each registration as
 * `<contract>.<hook>`; then registers reads of `project-a` and `project-b` on
 * the `files.refresh/v1` the activation provided.
 */
const activate = async (): Promise<Activation> => {
  installWindow();
  const { still, storyServices } = await import(
    '../../stories/support/services.js'
  );
  const { activate: activateFiles } = await import('../../src/client/index.js');
  const nothing = { dispose: () => undefined };
  const handlers = new Map<string, (input: unknown) => unknown>();
  const disposed: string[] = [];
  const provided: unknown[] = [];
  const base = storyServices({
    apis: {
      'ui/v1': { define: () => nothing },
      'commands/v1': { register: () => nothing },
      'regions/v1': { add: () => nothing },
      'layout.panel/v3': { ...still, select: () => undefined },
      'hooks/v1': {
        whenAvailable: (
          contract: HooksContract,
          callback: (registrar: unknown) => unknown,
        ) => {
          const registrar = Object.fromEntries(
            Object.keys(contract.hooks).map((hook) => [
              hook,
              (handler: (input: unknown) => unknown) => {
                const key = `${contract.id}.${hook}`;
                handlers.set(key, handler);
                return { dispose: () => disposed.push(key) };
              },
            ]),
          );
          const cleanup = callback(registrar);
          return {
            dispose: () => {
              if (typeof cleanup === 'function') cleanup();
            },
          };
        },
      },
    },
  });
  const cleanup = activateFiles({
    services: {
      ...base,
      provide: (definition: unknown) => {
        provided.push(definition);
        return nothing;
      },
    },
  } as unknown as Parameters<typeof activateFiles>[0]);

  const refresh = provided.find(
    (definition) => (definition as { id?: unknown }).id === FilesRefreshV1.id,
  );
  assert.ok(refresh, 'the activation provides files.refresh/v1');
  const harness = createTestServices({
    bundle: { id: 'git' },
    provide: [refresh as never],
  });
  const refreshed: string[] = [];
  for (const projectId of ['project-a', 'project-b'])
    harness.services.use(FilesRefreshV1).register({
      projectId,
      active: () => false,
      refresh: async () => {
        refreshed.push(projectId);
      },
    });
  return {
    handlers,
    disposed,
    refreshed,
    cleanup: () => {
      if (typeof cleanup === 'function') cleanup();
      void harness.dispose();
    },
  };
};

describe('the activation on chat.hooks/v2', () => {
  test('registers onSandboxActivityHook and onThreadUpdateHook on chat.hooks/v2 and nothing on chat.hooks/v1', async () => {
    activation = await activate();

    assert.deepEqual(
      [...activation.handlers.keys()]
        .filter((key) => key.startsWith('chat.hooks/'))
        .sort(),
      [
        'chat.hooks/v2.onSandboxActivityHook',
        'chat.hooks/v2.onThreadUpdateHook',
      ],
    );
  });

  test("a sandbox activity and a finished edit each refresh their Project's reads", async () => {
    activation = await activate();
    const sandbox = activation.handlers.get(
      'chat.hooks/v2.onSandboxActivityHook',
    );
    const update = activation.handlers.get('chat.hooks/v2.onThreadUpdateHook');
    assert.ok(sandbox, 'no onSandboxActivityHook on chat.hooks/v2');
    assert.ok(update, 'no onThreadUpdateHook on chat.hooks/v2');

    sandbox({ projectId: 'project-a' });
    update(live('project-b', 'tool.finished', 'edit'));

    assert.deepEqual(activation.refreshed, ['project-a', 'project-b']);
  });

  test('cleanup disposes both registrations', async () => {
    activation = await activate();

    activation.cleanup();

    assert.deepEqual(
      activation.disposed.filter((key) => key.startsWith('chat.hooks/')).sort(),
      [
        'chat.hooks/v2.onSandboxActivityHook',
        'chat.hooks/v2.onThreadUpdateHook',
      ],
    );
    activation = undefined;
  });
});
