// runtime's activation over the router (phase 3, slice S46a, contract §1.5,
// §1.7): the registrations, the start and stop steps and the
// `onEventAppendedHook` handler, as `core` drives them. Tests 10–15 of the
// slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { Code, ConnectError } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';

import { runtimeStorageTypes } from '../../src/host/store/index.js';
import {
  assertFails,
  callsOf,
  collect,
  gate,
  handleEventAppended,
  handleHostStart,
  handleHostStop,
  harness,
  rejectionOf,
  seedThread,
  settle,
  started,
  within,
} from './support.js';

const promptId = '00000000-0000-4000-8000-0000000000aa';

/** The Thread's `lastSequence` in a fresh `WatchProject` snapshot. */
const snapshotSequence = async (
  h: Awaited<ReturnType<typeof started>>,
  projectId: string,
  threadId: string,
): Promise<number | undefined> => {
  const controller = new AbortController();
  const items = collect(
    h.runtime().watchProject({ projectId }, { signal: controller.signal }),
  );

  try {
    await items.waitFor(1, 'the snapshot');
    const [first] = items.items;
    assert.equal(first?.item.case, 'snapshot');

    return first.item.value.threads.find(({ id }) => id === threadId)
      ?.lastSequence;
  } finally {
    controller.abort();
    await items.done;
  }
};

describe('activation', () => {
  test('10: before activate resolved, runtime/v2.Project fails unavailable', async (t) => {
    const held = gate();
    const h = harness({ defineTypeGate: held.promise });
    t.after(() => h.stop());

    const activation = h.activate();
    await settle();

    await assertFails(
      h.runtime().project({ id: '00000000-0000-4000-8000-000000000001' }),
      'unavailable',
    );

    held.open();
    await within(activation, 'activate');
  });

  test("11: activate defines the five storage types, registers the event and today's sink, defines runtime.hooks/v1 and registers the three hook handlers", async (t) => {
    const h = await started(t);

    assert.deepEqual(
      callsOf(h, 'storage.defineType')
        .map((request) => (request as { type: string }).type)
        .sort(),
      [
        'runtime.attachment/v1',
        'runtime.history/v1',
        'runtime.migration/v1',
        'runtime.project/v1',
        'runtime.thread/v1',
      ],
    );
    assert.deepEqual(
      runtimeStorageTypes.map(({ type }) => type).sort(),
      callsOf(h, 'storage.defineType')
        .map((request) => (request as { type: string }).type)
        .sort(),
    );
    assert.deepEqual(callsOf(h, 'events.register'), [
      {
        type: 'runtime.prompt-finished/v1',
        messageType: 'doric.runtime.prompt_finished.v1.PromptFinished',
      },
    ]);
    assert.deepEqual(callsOf(h, 'events.sink'), [
      {
        scopeKeys: ['projectId', 'threadId', 'promptId'],
        stream: 'runtime.thread.events/{threadId}',
        scopeDescription: 'a project, a Thread and a prompt',
      },
    ]);
    // The definition is not awaited by `activate`; it is sent all the same.
    await settle();
    assert.deepEqual(callsOf(h, 'hooks.define'), [
      { contract: 'runtime.hooks/v1' },
    ]);
    assert.deepEqual(
      callsOf(h, 'hooks.register')
        .map((request) => JSON.stringify(request))
        .sort(),
      [
        { contract: 'core.event-hooks/v1', hook: 'onEventAppendedHook' },
        { contract: 'doric.app.hooks/v1', hook: 'onHostStartHook' },
        { contract: 'doric.app.hooks/v1', hook: 'onHostStopHook' },
      ]
        .map((request) => JSON.stringify(request))
        .sort(),
    );
  });

  test("12: a refused DefineType rejects activate with the provider's code", async (t) => {
    const h = harness({
      defineTypeError: (type) =>
        type === 'runtime.thread/v1'
          ? new ContractError('not_owner', `${type} belongs to another bundle.`)
          : undefined,
    });
    t.after(() => h.stop());

    await assertFails(h.activate(), 'not_owner');
  });

  test('13: onEventAppendedHook on a Thread log folds the appended row into the Thread; a stream of another prefix does nothing', async (t) => {
    const h = harness();
    t.after(() => h.stop());
    const { project, thread } = await seedThread(h);
    await h.seed.threads.appendEvent(thread.id, promptId, {
      type: 'prompt.accepted',
      text: 'hello',
      source: { kind: 'user' },
    });
    await h.start();
    const stream = `runtime.thread.events/${thread.id}`;

    assert.equal(await snapshotSequence(h, project.id, thread.id), 1);

    // A row another bundle appended through `events/v1`, the Thread idle.
    await h.backend.second().commit({
      append: [
        {
          stream,
          events: [
            {
              projectId: project.id,
              threadId: thread.id,
              promptId,
              type: 'artifacts.created/v1',
              event: { type: 'artifacts.created/v1', artifactId: 'a-1' },
            },
          ],
        },
      ],
    });

    await within(
      handleEventAppended(h, `other.events/${thread.id}`, 'artifacts.created/v1'),
      'Handle (another prefix)',
    );
    assert.equal(await snapshotSequence(h, project.id, thread.id), 1);

    await within(
      handleEventAppended(h, stream, 'artifacts.created/v1'),
      'Handle (the Thread log)',
    );
    assert.equal(await snapshotSequence(h, project.id, thread.id), 2);
  });

  test('14: onHostStartHook stages workspace_reconciliation, logs before and after the recovery, and a Thread stored as running reads afterwards as interrupted', async (t) => {
    const h = harness();
    t.after(() => h.stop());
    const { project, thread } = await seedThread(h, { threadState: 'running' });
    await h.start();

    await within(handleHostStart(h), 'Handle (onHostStartHook)');

    const startup = h.calls.filter(({ method }) =>
      method.startsWith('startup.'),
    );
    assert.deepEqual(startup, [
      {
        method: 'startup.stage',
        request: { name: 'workspace_reconciliation' },
      },
      {
        method: 'startup.log',
        request: {
          level: 'info',
          message: 'Reconciling persisted projects and threads',
          fields: {},
        },
      },
      {
        method: 'startup.log',
        request: {
          level: 'info',
          message: 'Workspace reconciled',
          fields: { interruptedThreads: 1, interruptedProjects: 1 },
        },
      },
    ]);

    const controller = new AbortController();
    const items = collect(
      h.runtime().watchProject(
        { projectId: project.id },
        { signal: controller.signal },
      ),
    );
    await items.waitFor(1, 'the snapshot');
    controller.abort();
    await items.done;
    const [snapshot] = items.items;
    assert.equal(snapshot?.item.case, 'snapshot');
    const recovered = snapshot.item.value.threads.find(
      ({ id }) => id === thread.id,
    );
    assert.equal(recovered?.state, 'ready');
    assert.equal(recovered?.activePromptId, undefined);
  });

  test("15: onHostStopHook disposes; a later CreateProject fails FAILED_PRECONDITION, code shutting_down, today's message", async (t) => {
    const h = await started(t);

    await within(handleHostStop(h), 'Handle (onHostStopHook)');

    const error = await rejectionOf(h.runtime().createProject({ name: 'Late' }));
    assert.ok(error instanceof ConnectError, String(error));
    assert.equal(error.code, Code.FailedPrecondition);
    const failure = await assertFails(Promise.reject(error), 'shutting_down');
    assert.equal(failure.message, 'Doric is shutting down.');
  });
});
