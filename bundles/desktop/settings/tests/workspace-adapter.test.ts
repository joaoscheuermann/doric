// The settings adapter's view of the workspace window: the selected Thread
// read through the optional `layout.workspace/v1`, its change notifications
// (including the provider coming and going), and a Thread's execution written
// through `runtime.threads/v1.setThreadExecution`.

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import type { Disposable } from 'bundle/contracts';
import type { Thread, ThreadExecutionResult } from 'runtime/contracts';

import {
  api,
  initSettingsApi,
  setWorkspaceAvailable,
} from '../src/client/api/settings-api.js';
import { settingsOver } from './support/host.js';

const thread = (id: string, execution: Record<string, string>): Thread =>
  ({
    id,
    projectId: 'p-1',
    name: `Thread ${id}`,
    state: 'ready',
    lastSequence: 0,
    cwd: '/workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...execution,
  }) as Thread;

/**
 * The layout's side of `layout.workspace/v1`: a selection the test sets and
 * the listeners the adapter attached, which the test notifies.
 */
const layoutWorkspace = () => {
  const attached = new Set<() => void>();
  let selected: Thread | undefined;

  return {
    selectedThread: () => selected,
    workspaceSubscribe: (listener: () => void): Disposable => {
      attached.add(listener);
      return { dispose: () => attached.delete(listener) };
    },
    select: (next: Thread | undefined): void => {
      selected = next;
    },
    notify: (): void => {
      for (const listener of [...attached]) listener();
    },
    /** How many subscriptions the adapter holds on the layout now. */
    attached: (): number => attached.size,
  };
};

afterEach(() => {
  setWorkspaceAvailable(false);
});

describe('the selected Thread', () => {
  test('without the workspace provider there is no selection and nothing is attached', async () => {
    const layout = layoutWorkspace();
    layout.select(thread('t-1', { providerId: 'openrouter', model: 'm-1' }));
    setWorkspaceAvailable(false);

    await settingsOver(layout, async (api) => {
      let heard = 0;
      const subscription = api.workspace.subscribe(() => {
        heard += 1;
      });

      assert.equal(api.workspace.selectedThread(), undefined);
      assert.equal(layout.attached(), 0);
      layout.notify();
      assert.equal(heard, 0);
      subscription.dispose();
    });
  });

  test('the provider appearing is heard once, then the selection and its notifications reach the listener', async () => {
    const layout = layoutWorkspace();
    const selected = thread('t-1', { providerId: 'openrouter', model: 'm-1' });
    layout.select(selected);
    setWorkspaceAvailable(false);

    await settingsOver(layout, async (api) => {
      let heard = 0;
      const subscription = api.workspace.subscribe(() => {
        heard += 1;
      });

      setWorkspaceAvailable(true);
      assert.equal(heard, 1);
      assert.deepEqual(api.workspace.selectedThread(), selected);
      assert.equal(layout.attached(), 1);

      layout.notify();
      assert.equal(heard, 2);
      subscription.dispose();
    });
  });

  test('the provider going is heard once and detaches the layout subscription', async () => {
    const layout = layoutWorkspace();
    layout.select(thread('t-1', { providerId: 'openrouter', model: 'm-1' }));
    setWorkspaceAvailable(true);

    await settingsOver(layout, async (api) => {
      let heard = 0;
      const subscription = api.workspace.subscribe(() => {
        heard += 1;
      });
      assert.equal(layout.attached(), 1);

      setWorkspaceAvailable(false);
      assert.equal(heard, 1);
      assert.equal(layout.attached(), 0);
      assert.equal(api.workspace.selectedThread(), undefined);
      subscription.dispose();
    });
  });

  test('after the subscription is disposed, neither availability nor the layout reaches the listener', async () => {
    const layout = layoutWorkspace();
    layout.select(thread('t-1', { providerId: 'openrouter', model: 'm-1' }));
    setWorkspaceAvailable(true);

    await settingsOver(layout, async (api) => {
      let heard = 0;
      const subscription = api.workspace.subscribe(() => {
        heard += 1;
      });

      subscription.dispose();
      assert.equal(layout.attached(), 0);
      layout.notify();
      setWorkspaceAvailable(false);
      setWorkspaceAvailable(true);
      assert.equal(heard, 0);
      assert.equal(layout.attached(), 0);
    });
  });
});

describe("a Thread's execution", () => {
  test('setExecution asks runtime.threads/v1.setThreadExecution with the input and answers its result', async () => {
    const asked: unknown[] = [];
    const answer: ThreadExecutionResult = {
      status: 'updated',
      thread: thread('t-1', {
        providerId: 'openrouter',
        model: 'm-2',
        effort: 'high',
      }),
    };

    await settingsOver(
      {
        setThreadExecution: (input) => {
          asked.push(input);
          return answer;
        },
      },
      async (api) => {
        const result = await api.threads.setExecution({
          id: 't-1',
          providerId: 'openrouter',
          model: 'm-2',
          effort: 'high',
        });

        assert.deepEqual(asked, [
          { id: 't-1', providerId: 'openrouter', model: 'm-2', effort: 'high' },
        ]);
        assert.deepEqual(result, answer);
      },
    );
  });

  test('a refusal is answered as a value, not a rejection', async () => {
    await settingsOver(
      { setThreadExecution: () => ({ status: 'invalid', reason: 'effort' }) },
      async (api) => {
        assert.deepEqual(
          await api.threads.setExecution({
            id: 't-1',
            providerId: 'openrouter',
            model: 'm-2',
            effort: 'max',
          }),
          { status: 'invalid', reason: 'effort' },
        );
      },
    );
  });
});

// T-22 (error-messages.md §6.4): with the settings bridge unset, `api()`
// throws at once — not a rejection — a `SettingsApiError` with code
// `internal` that says a repeat fails the same way (`retryable: false`), so
// no notice offers Retry for it.
describe('T-22 the unset settings bridge', () => {
  test('api() throws synchronously SettingsApiError internal, not retryable, with no cause', () => {
    initSettingsApi(undefined);
    let thrown: unknown;
    try {
      api();
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof Error, 'api() returned instead of throwing');
    const error = thrown as Error & {
      readonly code?: unknown;
      readonly retryable?: unknown;
    };
    assert.equal(error.name, 'SettingsApiError');
    assert.equal(error.code, 'internal');
    assert.equal(error.retryable, false);
    assert.equal(error.message, 'Doric backend is unavailable.');
    assert.equal(error.cause, undefined);
  });
});
