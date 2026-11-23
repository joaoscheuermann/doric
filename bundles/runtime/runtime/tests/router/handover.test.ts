// The generation handover over the router (phase 3, slice S46b, contract
// §2.3): `context.generations.onChanged` and `onSignal` drive today's
// decisions (`recoverWith`, `drain`, `adopt`), the drain holds the instance
// through `doric.generation/v1.Hold` / `Release` and announces each released
// Project with `Signal{topic: 'runtime.released'}`. Tests 41–43 of the slice.
//
// The lifecycle is the seam the handover drives (`installRoutedHandover`'s
// second argument), so these cases record its calls; the generation frames
// and `doric.generation/v1` go through the test router. One case runs the
// started bundle to show `activate` installs the handover.

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { fromJson } from '@bufbuild/protobuf';
import { ValueSchema } from '@bufbuild/protobuf/wkt';

import type { Handover, RecoverySummary } from '../../src/contracts/runtime.js';
import type { RuntimeLifecycle } from '../../src/host/lifecycle.js';
import { installRoutedHandover } from '../../src/host/rpc/handover.js';
import {
  callsOf,
  contextHarness,
  eventually,
  type Gate,
  gate,
  projectState,
  settle,
  started,
} from './support.js';

/** This process, as the test router's instance is. */
const self = { bundleId: 'runtime', generation: 1, incarnation: 1 };
/** Another generation of runtime. */
const successor = { bundleId: 'runtime', generation: 2, incarnation: 1 };

const summary: RecoverySummary = {
  interruptedThreads: 0,
  interruptedProjects: 0,
  resumedPrompts: 0,
};

/** One call the handover made on the lifecycle. */
type LifecycleCall =
  | { readonly method: 'recoverWith' | 'adopt'; readonly handover: Handover }
  | { readonly method: 'drain' | 'recover' | 'dispose' };

/**
 * A lifecycle that records each call. `drain` releases `released` in order,
 * then settles once `drained` opens.
 */
const recordingLifecycle = (
  released: readonly string[] = [],
  drained: Gate = (() => {
    const open = gate();
    open.open();
    return open;
  })(),
) => {
  const calls: LifecycleCall[] = [];
  const lifecycle: RuntimeLifecycle = {
    recover: async () => {
      calls.push({ method: 'recover' });
      return summary;
    },
    recoverWith: async (handover) => {
      calls.push({ method: 'recoverWith', handover });
      return summary;
    },
    adopt: async (handover) => {
      calls.push({ method: 'adopt', handover });
    },
    drain: async (release) => {
      calls.push({ method: 'drain' });
      for (const projectId of released) release(projectId);
      await drained.promise;
    },
    dispose: async () => {
      calls.push({ method: 'dispose' });
    },
  };

  return { calls, lifecycle };
};

const methodsOf = (calls: readonly LifecycleCall[]) =>
  calls.map(({ method }) => method);

describe('the generation handover', () => {
  test('41: a GenerationChanged that makes this instance active calls recoverWith with the live owners', async (t) => {
    const h = await contextHarness(t);
    const { calls, lifecycle } = recordingLifecycle();
    const remove = installRoutedHandover(h.context, lifecycle);
    t.after(() => remove());

    await h.control.generationChanged({
      event: 'activated',
      subject: self,
      live: [
        { instance: successor, state: 'draining' },
        { instance: self, state: 'active' },
      ],
    });

    await eventually(() => calls.length > 0, 'the recovery');
    assert.deepEqual(calls, [
      {
        method: 'recoverWith',
        handover: { live: [{ generation: 2, incarnation: 1 }] },
      },
    ]);
  });

  test('41: an activation while this instance is not active, or not live, recovers nothing', async (t) => {
    const h = await contextHarness(t);
    const { calls, lifecycle } = recordingLifecycle();
    const remove = installRoutedHandover(h.context, lifecycle);
    t.after(() => remove());

    await h.control.generationChanged({
      event: 'activated',
      subject: successor,
      live: [
        { instance: successor, state: 'active' },
        { instance: self, state: 'draining' },
      ],
    });
    await h.control.generationChanged({
      event: 'activated',
      subject: successor,
      live: [{ instance: successor, state: 'active' }],
    });
    await settle();

    assert.deepEqual(calls, []);
  });

  test('42: a draining change takes Hold before it answers, drains, signals runtime.released per Project, then Releases', async (t) => {
    const h = await contextHarness(t);
    const drained = gate();
    const { calls, lifecycle } = recordingLifecycle(
      ['project-a', 'project-b'],
      drained,
    );
    const remove = installRoutedHandover(h.context, lifecycle);
    t.after(() => {
      drained.open();
      remove();
    });

    await h.control.generationChanged({
      event: 'draining',
      subject: self,
      live: [
        { instance: self, state: 'draining' },
        { instance: successor, state: 'active' },
      ],
    });

    // The hold is taken before the change is acknowledged.
    const [hold] = callsOf(h, 'generation.hold') as {
      key: string;
      holdId: string;
    }[];
    assert.ok(hold !== undefined, 'a hold before the acknowledgement');
    assert.equal(hold.key, 'runtime.drain');
    await eventually(
      () => callsOf(h, 'generation.signal').length === 2,
      'a signal per released Project',
    );
    assert.deepEqual(callsOf(h, 'generation.signal'), [
      { topic: 'runtime.released', payload: { projectId: 'project-a' } },
      { topic: 'runtime.released', payload: { projectId: 'project-b' } },
    ]);
    assert.deepEqual(methodsOf(calls), ['drain']);
    await settle();
    assert.deepEqual(
      callsOf(h, 'generation.release'),
      [],
      'held while the drain runs',
    );

    drained.open();
    await eventually(
      () => callsOf(h, 'generation.release').length === 1,
      'the release',
    );
    assert.deepEqual(callsOf(h, 'generation.release'), [
      { holdId: hold.holdId },
    ]);
    const order = h.calls
      .map(({ method }) => method)
      .filter((method) => method.startsWith('generation.'));
    assert.deepEqual(order, [
      'generation.hold',
      'generation.signal',
      'generation.signal',
      'generation.release',
    ]);
  });

  test('42: the draining change of another generation takes no hold and drains nothing', async (t) => {
    const h = await contextHarness(t);
    const { calls, lifecycle } = recordingLifecycle(['project-a']);
    const remove = installRoutedHandover(h.context, lifecycle);
    t.after(() => remove());

    await h.control.generationChanged({
      event: 'draining',
      subject: successor,
      live: [
        { instance: self, state: 'active' },
        { instance: successor, state: 'draining' },
      ],
    });
    await settle();

    assert.deepEqual(calls, []);
    assert.deepEqual(callsOf(h, 'generation.hold'), []);
    assert.deepEqual(callsOf(h, 'generation.signal'), []);
  });

  test('42: the activated bundle drains its Projects on a draining change (activate installs the handover)', async (t) => {
    const h = await started(t);
    const ids: string[] = [];
    for (const name of ['One', 'Two']) {
      const { project } = await h.runtime().createProject({ name });
      assert.ok(project !== undefined);
      ids.push(project.id);
      await projectState(h, project.id, 'ready');
    }

    await h.control.generationChanged({
      event: 'draining',
      subject: self,
      live: [
        { instance: self, state: 'draining' },
        { instance: successor, state: 'active' },
      ],
    });

    await eventually(
      () => callsOf(h, 'generation.release').length === 1,
      'the drain to end',
    );
    assert.equal(callsOf(h, 'generation.hold').length, 1);
    assert.deepEqual(
      (
        callsOf(h, 'generation.signal') as {
          topic: string;
          payload: { projectId: string };
        }[]
      )
        .map(({ topic, payload }) => `${topic} ${payload.projectId}`)
        .sort(),
      ids.map((id) => `runtime.released ${id}`).sort(),
    );
  });

  test('43: a runtime.released signal from another runtime instance makes the active one adopt', async (t) => {
    const h = await contextHarness(t);
    const { calls, lifecycle } = recordingLifecycle();
    const remove = installRoutedHandover(h.context, lifecycle);
    t.after(() => remove());

    await h.control.peerSignal({
      topic: 'runtime.released',
      payload: fromJson(ValueSchema, { projectId: 'project-a' }),
      from: successor,
    });

    await eventually(() => calls.length > 0, 'the adoption');
    // Before any generation change, this instance alone is live and active.
    assert.deepEqual(calls, [
      {
        method: 'adopt',
        handover: { live: [{ generation: 1, incarnation: 1 }] },
      },
    ]);
  });

  test('43: a runtime.released signal from another bundle, or another topic, is ignored', async (t) => {
    const h = await contextHarness(t);
    const { calls, lifecycle } = recordingLifecycle();
    const remove = installRoutedHandover(h.context, lifecycle);
    t.after(() => remove());

    await h.control.peerSignal({
      topic: 'runtime.released',
      payload: fromJson(ValueSchema, { projectId: 'project-a' }),
      from: { bundleId: 'mcp', generation: 2, incarnation: 1 },
    });
    await h.control.peerSignal({
      topic: 'other.topic',
      payload: fromJson(ValueSchema, { projectId: 'project-a' }),
      from: successor,
    });
    await settle();

    assert.deepEqual(calls, []);
  });

  test('the function installRoutedHandover answers removes both handlers', async (t) => {
    const h = await contextHarness(t);
    const { calls, lifecycle } = recordingLifecycle();
    const remove = installRoutedHandover(h.context, lifecycle);

    remove();
    await h.control.generationChanged({
      event: 'activated',
      subject: self,
      live: [{ instance: self, state: 'active' }],
    });
    await h.control.peerSignal({
      topic: 'runtime.released',
      payload: fromJson(ValueSchema, { projectId: 'project-a' }),
      from: successor,
    });
    await settle();

    assert.deepEqual(calls, []);
  });
});
