// `runtime/v2` over the router (phase 3, slice S46a, contract §1.8): the
// Project RPCs answer what the kernel's `runtime/v2` answers over the same
// kind of store, the notice streams deliver in commit order, and
// `runtime.hooks/v1` runs through `hooks/v1`. Tests 16–21 of the slice.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { toJson } from '@bufbuild/protobuf';
import { anyUnpack } from '@bufbuild/protobuf/wkt';
import { ContractError } from 'bundle/contracts';

import { OnProjectReadyHookInputSchema } from '../../src/contracts/gen/doric/runtime/hooks/v1/hooks_pb.js';
import {
  type Project,
  ProjectSchema,
} from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import { createHarness } from '../domain/support/harness.js';
import { normalize } from '../support/capture-adapter.js';
import {
  assertFails,
  collect,
  eventually,
  type Harness,
  harness,
  projectState,
  seedThread,
  started,
  within,
} from './support.js';

const unknownId = '00000000-0000-4000-8000-00000000ffff';

const projectJson = (project: Project | undefined) =>
  project === undefined
    ? undefined
    : toJson(ProjectSchema, project, { alwaysEmitImplicit: true });

/** One sequence of Project calls, as both sides answer it. */
interface ProjectCalls {
  create(name: string): Promise<{ id: string }>;
  ready(id: string): Promise<void>;
  find(id: string): Promise<unknown>;
  page(limit: number, cursor?: string): Promise<{ nextCursor?: string }>;
  rename(id: string, name: string): Promise<unknown>;
  setColor(id: string, color: string | null): Promise<unknown>;
  terminate(id: string): Promise<unknown>;
  delete(id: string): Promise<unknown>;
}

/** The answers of the sequence; colors other than set ones are random. */
const scenario = async (calls: ProjectCalls) => {
  const answers: { step: string; answer: unknown }[] = [];
  const keep = (step: string, answer: unknown, color = false) => {
    const json = JSON.parse(JSON.stringify(answer ?? null)) as unknown;
    const strip = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(strip)
        : typeof value === 'object' && value !== null
          ? Object.fromEntries(
              Object.entries(value).map(([key, item]) => [
                key,
                key === 'color' && !color ? '<color>' : strip(item),
              ]),
            )
          : value;
    answers.push({ step, answer: strip(json) });
  };
  const alpha = await calls.create('Alpha');
  keep('create Alpha', alpha);
  await calls.ready(alpha.id);
  const beta = await calls.create('Beta');
  keep('create Beta', beta);
  await calls.ready(beta.id);
  keep('find Alpha', await calls.find(alpha.id));
  keep('find unknown', await calls.find(unknownId));
  const first = await calls.page(1);
  keep('page 1', first);
  keep('page 2', await calls.page(1, first.nextCursor));
  keep('rename Alpha', await calls.rename(alpha.id, 'Alpha 2'));
  keep('color Alpha teal', await calls.setColor(alpha.id, 'teal'), true);
  keep('color Alpha clear', await calls.setColor(alpha.id, null), true);
  keep('delete Alpha (active)', await calls.delete(alpha.id));
  keep('terminate Beta', await calls.terminate(beta.id));
  keep('delete Beta', await calls.delete(beta.id));
  keep('find Beta', await calls.find(beta.id));

  return normalize(answers);
};

const routedCalls = (h: Harness): ProjectCalls => {
  const runtime = h.runtime();

  return {
    create: async (name) => {
      const { project } = await runtime.createProject({ name });
      assert.ok(project !== undefined);

      return projectJson(project) as { id: string };
    },
    ready: (id) => projectState(h, id, 'ready'),
    find: async (id) => projectJson((await runtime.project({ id })).project),
    page: async (limit, cursor) => {
      const page = await runtime.projects({
        limit,
        ...(cursor === undefined ? {} : { cursor }),
      });

      return {
        items: page.items.map(projectJson),
        ...(page.nextCursor === undefined
          ? {}
          : { nextCursor: page.nextCursor }),
      };
    },
    rename: async (id, name) =>
      projectJson((await runtime.renameProject({ id, name })).project),
    setColor: async (id, color) =>
      projectJson(
        (
          await runtime.setProjectColor({
            id,
            ...(color === null ? {} : { color }),
          })
        ).project,
      ),
    terminate: async (id) =>
      projectJson((await runtime.terminateProject({ id })).project),
    delete: async (id) => (await runtime.deleteProject({ id })).deleteResult,
  };
};

const kernelCalls = (
  kernel: ReturnType<typeof createHarness>,
): ProjectCalls => ({
  create: (name) => kernel.runtime.createProject({ name }),
  ready: (id) => kernel.projectState(id, 'ready'),
  find: (id) => kernel.runtime.project(id),
  page: (limit, cursor) =>
    kernel.runtime.projects({
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    }),
  rename: (id, name) => kernel.runtime.renameProject({ id, name }),
  setColor: (id, color) =>
    kernel.runtime.setProjectColor({
      id,
      color: color as Parameters<
        typeof kernel.runtime.setProjectColor
      >[0]['color'],
    }),
  terminate: (id) => kernel.runtime.terminateProject(id),
  delete: (id) => kernel.runtime.deleteProject(id),
});

describe('runtime/v2', () => {
  test("16: the Project RPCs answer what provideRuntime's runtime/v2 answers for the same calls", async (t) => {
    const h = await started(t);
    const kernel = createHarness();
    t.after(() => kernel.dispose());

    const routed = await scenario(routedCalls(h));
    const today = await scenario(kernelCalls(kernel));

    assert.deepEqual(routed, today);
  });

  test('17: an invalid color fails invalid_input', async (t) => {
    const h = await started(t);
    const { project } = await h.runtime().createProject({ name: 'Colors' });
    assert.ok(project !== undefined);

    await assertFails(
      h.runtime().setProjectColor({ id: project.id, color: 'purple' }),
      'invalid_input',
    );
  });

  test('18: Watch yields projectUpdated after CreateProject, in commit order; cancelling the stream ends it', async (t) => {
    const h = await started(t);
    const controller = new AbortController();
    const notices = collect(
      h.runtime().watch({}, { signal: controller.signal }),
    );
    // The stream is open once a first notice could arrive.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { project: first } = await h.runtime().createProject({ name: 'A' });
    const { project: second } = await h.runtime().createProject({ name: 'B' });
    assert.ok(first !== undefined && second !== undefined);

    await eventually(
      () =>
        notices.items.filter(
          ({ notice }) =>
            notice.case === 'projectUpdated' && notice.value.id === second.id,
        ).length > 0,
      'projectUpdated of B',
    );
    const created = notices.items.flatMap(({ notice }) =>
      notice.case === 'projectUpdated' ? [notice.value] : [],
    );
    const firstIndex = created.findIndex(({ id }) => id === first.id);
    const secondIndex = created.findIndex(({ id }) => id === second.id);
    assert.ok(firstIndex >= 0 && firstIndex < secondIndex, 'in commit order');
    assert.equal(created[firstIndex]?.name, 'A');

    controller.abort();
    await within(notices.done, 'the cancelled Watch to end');
    const seen = notices.items.length;
    await h.runtime().createProject({ name: 'C' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(notices.items.length, seen);
  });

  test('19: WatchProject yields the snapshot first, then threadUpdated and projectDeleted items', async (t) => {
    const h = harness();
    t.after(() => h.stop());
    const { project, thread } = await seedThread(h);
    await h.start();
    const controller = new AbortController();
    t.after(() => controller.abort());
    const items = collect(
      h.runtime().watchProject(
        { projectId: project.id },
        { signal: controller.signal },
      ),
    );

    await items.waitFor(1, 'the snapshot');
    const [snapshot] = items.items;
    assert.equal(snapshot?.item.case, 'snapshot');
    assert.equal(snapshot.item.value.projectId, project.id);
    assert.equal(snapshot.item.value.project?.id, project.id);
    assert.deepEqual(
      snapshot.item.value.threads.map(({ id }) => id),
      [thread.id],
    );

    await h.runtime().terminateProject({ id: project.id });
    await eventually(
      () =>
        items.items.some(
          ({ item }) =>
            item.case === 'threadUpdated' && item.value.id === thread.id,
        ),
      'threadUpdated of the Thread',
    );

    assert.equal(
      (await h.runtime().deleteProject({ id: project.id })).deleteResult,
      'deleted',
    );
    await eventually(
      () =>
        items.items.some(
          ({ item }) =>
            item.case === 'projectDeleted' &&
            item.value.projectId === project.id,
        ),
      'projectDeleted',
    );
    assert.equal(items.items.at(-1)?.item.case, 'projectDeleted');
    assert.equal(
      items.items.filter(({ item }) => item.case === 'snapshot').length,
      1,
    );
  });

  test('20: Drain streams each released Project id and ends when the drain completes', async (t) => {
    const h = await started(t);
    const ids: string[] = [];
    for (const name of ['One', 'Two']) {
      const { project } = await h.runtime().createProject({ name });
      assert.ok(project !== undefined);
      ids.push(project.id);
      await projectState(h, project.id, 'ready');
    }

    const released = collect(h.runtime().drain({}));
    await within(released.done, 'the drain to end');

    assert.equal(released.error(), undefined);
    assert.deepEqual(
      released.items.map(({ projectId }) => projectId).sort(),
      [...ids].sort(),
    );
  });

  test('21: a Project that becomes ready runs onProjectReadyHook through hooks/v1.Run, after the definition', async (t) => {
    const h = await started(t);
    const { project } = await h.runtime().createProject({ name: 'Ready' });
    assert.ok(project !== undefined);
    await projectState(h, project.id, 'ready');

    await eventually(
      () => h.runs.some(({ hook }) => hook === 'onProjectReadyHook'),
      'the onProjectReadyHook run',
    );
    const run = h.runs.find(({ hook }) => hook === 'onProjectReadyHook');
    assert.equal(run?.contract, 'runtime.hooks/v1');
    assert.ok(run !== undefined);
    const input = anyUnpack(run.input, OnProjectReadyHookInputSchema);
    assert.equal(input?.projectId, project.id);
    const methods = h.calls.map(({ method }) => method);
    assert.ok(
      methods.indexOf('hooks.define') < methods.indexOf('hooks.run'),
      'Define before Run',
    );
  });

  test('21: a failing hooks/v1.Run does not fail CreateProject', async (t) => {
    const h = await started(t, {
      runError: new ContractError('internal', 'the handler failed'),
    });

    const { project } = await within(
      h.runtime().createProject({ name: 'Still' }),
      'CreateProject',
    );
    assert.ok(project !== undefined);
    await projectState(h, project.id, 'ready');
    await eventually(
      () => h.runs.some(({ hook }) => hook === 'onProjectReadyHook'),
      'the failed run',
    );
    assert.equal(
      (await h.runtime().project({ id: project.id })).project?.state,
      'ready',
    );
  });
});

