import assert from 'node:assert/strict';
import test from 'node:test';

import type { GenerationSummary, LostGeneration } from 'bundle';
import type { Services } from 'bundle/contracts';
import type {
  Handover,
  ReleasedListener,
  RuntimeOwner,
} from 'runtime/contracts';

import { installHandover } from '../src/lib/bundles/handover.js';

/*
 * The kernel side of the generation handover (57-WP-H): which runtime each
 * generation event reaches, and with which live processes. The runtime side
 * of the same handover is proven in bundles/runtime (domain/handover.test).
 */

interface RuntimeCall {
  readonly generation: number;
  readonly method: 'recoverWith' | 'adopt' | 'drain';
  readonly live?: readonly RuntimeOwner[];
}

const setup = () => {
  let summaries: GenerationSummary[] = [];
  const active = new Set<(generation: number) => void>();
  const lost = new Set<(value: LostGeneration) => void>();
  const calls: RuntimeCall[] = [];
  const drains = new Map<
    number,
    { released: ReleasedListener; finish: () => void }
  >();
  const runtimeOf = (generation: () => number) => ({
    recoverWith: async (handover: Handover) => {
      calls.push({
        generation: generation(),
        method: 'recoverWith',
        live: handover.live,
      });
      return {
        interruptedThreads: 0,
        interruptedProjects: 0,
        resumedPrompts: 0,
      };
    },
    adopt: async (handover: Handover) => {
      calls.push({
        generation: generation(),
        method: 'adopt',
        live: handover.live,
      });
    },
    drain: (released: ReleasedListener) => {
      calls.push({ generation: generation(), method: 'drain' });
      return new Promise<void>((finish) => {
        drains.set(generation(), { released, finish });
      });
    },
  });
  const servicesOf = (generation: () => number) =>
    ({ use: () => runtimeOf(generation) }) as unknown as Services;
  const log: { fields: Readonly<Record<string, unknown>>; message: string }[] =
    [];
  const uninstall = installHandover({
    generations: {
      describe: () => summaries,
      onActive: (listener) => {
        active.add(listener);
        return () => active.delete(listener);
      },
      onLost: (listener) => {
        lost.add(listener);
        return () => lost.delete(listener);
      },
    },
    view: (generation) => servicesOf(() => generation),
    // The kernel's own services resolve whichever generation is active now.
    services: servicesOf(
      () =>
        summaries.find((summary) => summary.state === 'active')?.generation ??
        0,
    ),
    log: {
      error: (fields, message) => {
        log.push({ fields, message });
      },
    },
  });

  return {
    calls,
    drains,
    log,
    uninstall,
    set: (next: GenerationSummary[]) => {
      summaries = next;
    },
    activate: (generation: number) => {
      for (const listener of [...active]) listener(generation);
    },
    lose: (value: LostGeneration) => {
      for (const listener of [...lost]) listener(value);
    },
  };
};

const summary = (
  generation: number,
  incarnation: number,
  state: GenerationSummary['state'],
): GenerationSummary => ({ generation, incarnation, state, work: 0 });

const turn = () => new Promise((done) => setTimeout(done, 0));

void test('a switch drains the replaced runtime and recovers its successor around its Projects', async () => {
  const host = setup();

  host.set([summary(1, 1, 'draining'), summary(2, 1, 'active')]);
  host.activate(2);

  // The drain starts inside the activation listener, before it returns.
  assert.deepEqual(host.calls, [
    { generation: 1, method: 'drain' },
    {
      generation: 2,
      method: 'recoverWith',
      live: [{ generation: 1, incarnation: 1 }],
    },
  ]);

  // Each Project generation 1 lets go is adopted by the active one.
  host.drains.get(1)?.released('project-a');
  await turn();
  assert.deepEqual(host.calls.at(-1), {
    generation: 2,
    method: 'adopt',
    live: [
      { generation: 1, incarnation: 1 },
      { generation: 2, incarnation: 1 },
    ],
  });

  host.set([summary(1, 1, 'stopped'), summary(2, 1, 'active')]);
  host.drains.get(1)?.finish();
  await turn();
  assert.deepEqual(host.calls.at(-1), {
    generation: 2,
    method: 'adopt',
    live: [{ generation: 2, incarnation: 1 }],
  });
  assert.deepEqual(host.log, []);
  host.uninstall();
});

void test('a draining generation that dies has its Projects adopted without it', async () => {
  const host = setup();

  host.set([summary(1, 1, 'draining'), summary(2, 1, 'active')]);
  host.activate(2);
  host.calls.length = 0;

  host.lose({ generation: 1, incarnation: 1, holds: [] });
  await turn();
  assert.deepEqual(host.calls, [
    {
      generation: 2,
      method: 'adopt',
      live: [{ generation: 2, incarnation: 1 }],
    },
  ]);
  host.uninstall();
});

void test('a respawned generation recovers with no other process alive and drains nothing', async () => {
  const host = setup();

  host.set([summary(1, 1, 'active')]);
  // The active generation dies: it respawns, nothing is adopted meanwhile.
  host.lose({ generation: 1, incarnation: 1, holds: [] });
  await turn();
  assert.deepEqual(host.calls, []);

  host.set([summary(1, 2, 'active')]);
  host.activate(1);
  assert.deepEqual(host.calls, [
    { generation: 1, method: 'recoverWith', live: [] },
  ]);
  host.uninstall();
});

void test('a failed generation activates no runtime', async () => {
  const host = setup();

  host.set([summary(1, 1, 'draining'), summary(2, 3, 'failed')]);
  host.activate(2);
  await turn();
  assert.deepEqual(host.calls, []);

  // Removing the listeners ends the handover.
  host.uninstall();
  host.set([summary(2, 1, 'draining'), summary(3, 1, 'active')]);
  host.activate(3);
  assert.deepEqual(host.calls, []);
});
