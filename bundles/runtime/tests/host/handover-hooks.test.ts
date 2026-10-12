import assert from 'node:assert/strict';
import test from 'node:test';

import type { Log, Services } from 'bundle/contracts';
import { DoricGenerationV1, DoricStartupV1, HooksV1 } from 'bundle/contracts';

import type {
  Handover,
  RecoverySummary,
  RuntimeOwner,
} from '../../src/contracts/runtime.js';
import { installHandover } from '../../src/host/handover.js';
import {
  installStartStop,
  type RuntimeLifecycle,
} from '../../src/host/lifecycle.js';

/*
 * The runtime's hooks (M3): which generation change or peer signal reaches
 * which lifecycle step. The Project-level handover itself is proven against
 * two runtimes over one storage in domain/handover.test.ts.
 */

type Handler = (input: unknown, call: unknown) => unknown;

interface Fakes {
  readonly services: Pick<Services, 'use'>;
  readonly handlers: Record<string, Handler>;
  readonly holds: { key: string; disposed: boolean }[];
  readonly signals: { topic: string; payload: unknown }[];
  readonly stages: string[];
  readonly lines: { message: string; fields: Record<string, unknown> }[];
  readonly calls: string[];
  readonly lifecycle: RuntimeLifecycle;
  readonly drained: {
    released: (projectId: string) => void;
    finish: () => void;
  }[];
  readonly recovered: RecoverySummary;
}

const fakes = (): Fakes => {
  const handlers: Record<string, Handler> = {};
  const holds: { key: string; disposed: boolean }[] = [];
  const signals: { topic: string; payload: unknown }[] = [];
  const stages: string[] = [];
  const lines: { message: string; fields: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  const drained: Fakes['drained'] = [];
  const recovered: RecoverySummary = {
    interruptedThreads: 1,
    interruptedProjects: 2,
    resumedPrompts: 3,
  };
  const hooksRegistrar = {
    onGenerationChangedHook: (handler: Handler) => {
      handlers.generationChanged = handler;
      return { dispose: () => undefined };
    },
    onPeerSignalHook: (handler: Handler) => {
      handlers.peerSignal = handler;
      return { dispose: () => undefined };
    },
    onHostStartHook: (handler: Handler) => {
      handlers.start = handler;
      return { dispose: () => undefined };
    },
    onHostStopHook: (handler: Handler) => {
      handlers.stop = handler;
      return { dispose: () => undefined };
    },
  };
  const generation = {
    hold: async (work: { key: string }) => {
      const held = { key: work.key, disposed: false };

      holds.push(held);
      return {
        dispose: () => {
          held.disposed = true;
        },
      };
    },
    signal: async (signal: { topic: string; payload: unknown }) => {
      signals.push(signal);
    },
  };
  const startup = {
    stage: async (name: string) => {
      stages.push(name);
    },
    log: async (record: {
      message: string;
      fields: Record<string, unknown>;
    }) => {
      lines.push({ message: record.message, fields: record.fields });
    },
  };
  const registrars: Record<string, unknown> = {
    [HooksV1.id]: { use: () => hooksRegistrar },
    [DoricGenerationV1.id]: generation,
    [DoricStartupV1.id]: startup,
  };
  const services = {
    use: (contract: { id: string }) => {
      const found = registrars[contract.id];

      if (found === undefined) throw new Error(`unexpected ${contract.id}`);

      return found;
    },
  } as unknown as Pick<Services, 'use'>;
  const lifecycle: RuntimeLifecycle = {
    recover: async () => {
      calls.push('recover');
      return recovered;
    },
    recoverWith: async (handover: Handover) => {
      calls.push(`recoverWith ${JSON.stringify(handover.live)}`);
      return recovered;
    },
    adopt: async (handover: Handover) => {
      calls.push(`adopt ${JSON.stringify(handover.live)}`);
    },
    drain: (released) =>
      new Promise<void>((finish) => {
        calls.push('drain');
        drained.push({ released, finish });
      }),
    dispose: async () => {
      calls.push('dispose');
    },
  };

  return {
    services,
    handlers,
    holds,
    signals,
    stages,
    lines,
    calls,
    lifecycle,
    drained,
    recovered,
  };
};

const log: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const owner = (generation: number, incarnation = 1) => ({
  generation,
  incarnation,
});
const live = (
  generation: number,
  state: 'active' | 'draining' | 'failed',
  incarnation = 1,
) => ({ generation, incarnation, state });

const change = (
  event: 'activated' | 'draining' | 'lost' | 'stopped',
  subject: RuntimeOwner,
  self: RuntimeOwner,
  members: ReturnType<typeof live>[],
) => ({
  event,
  generation: subject.generation,
  incarnation: subject.incarnation,
  self,
  live: members,
});

const turn = () => new Promise((done) => setTimeout(done, 0));

void test('a switch drains the replaced runtime, which releases each Project to the active one', async () => {
  const host = fakes();

  installHandover({ services: host.services, lifecycle: host.lifecycle, log });
  const handle = host.handlers.generationChanged as Handler;
  const peer = host.handlers.peerSignal as Handler;

  // Generation 1 hears it is draining: it takes its work hold, then drains.
  await handle(
    change('draining', owner(1), owner(1), [
      live(1, 'draining'),
      live(2, 'active'),
    ]),
    {},
  );
  assert.deepEqual(
    host.holds.map(({ key, disposed }) => ({ key, disposed })),
    [{ key: 'runtime.drain', disposed: false }],
  );
  assert.deepEqual(host.calls, ['drain']);

  // Each Project it lets go is signalled to the other generations.
  host.drained[0]?.released('project-a');
  await turn();
  assert.deepEqual(host.signals, [
    { topic: 'runtime.released', payload: { projectId: 'project-a' } },
  ]);

  // The active generation hears the switch: it recovers around the draining one.
  await handle(
    change('activated', owner(2), owner(2), [
      live(1, 'draining'),
      live(2, 'active'),
    ]),
    {},
  );
  assert.deepEqual(
    host.calls.at(-1),
    `recoverWith ${JSON.stringify([owner(1)])}`,
  );

  // The release arrives as a peer signal of the runtime: the active one adopts.
  await peer(
    {
      topic: 'runtime.released',
      payload: { projectId: 'project-a' },
      from: { bundleId: 'runtime', generation: 1, incarnation: 1 },
      self: owner(2),
      live: [live(1, 'draining'), live(2, 'active')],
    },
    {},
  );
  assert.deepEqual(
    host.calls.at(-1),
    `adopt ${JSON.stringify([owner(1), owner(2)])}`,
  );

  // The drain ends: the work hold goes, and the stop of generation 1 is adopted.
  host.drained[0]?.finish();
  await turn();
  assert.equal(host.holds[0]?.disposed, true);
  await handle(change('stopped', owner(1), owner(2), [live(2, 'active')]), {});
  assert.deepEqual(host.calls.at(-1), `adopt ${JSON.stringify([owner(2)])}`);
});

void test('a draining runtime that is lost is adopted without it, by the active one only', async () => {
  const host = fakes();

  installHandover({ services: host.services, lifecycle: host.lifecycle, log });
  const handle = host.handlers.generationChanged as Handler;

  // The draining generation hears of the loss of the active one: no adoption.
  await handle(change('lost', owner(2), owner(1), [live(1, 'draining')]), {});
  assert.deepEqual(host.calls, []);

  await handle(change('lost', owner(1), owner(2), [live(2, 'active')]), {});
  assert.deepEqual(host.calls, [`adopt ${JSON.stringify([owner(2)])}`]);
});

void test('a respawned generation recovers with no other process alive', async () => {
  const host = fakes();

  installHandover({ services: host.services, lifecycle: host.lifecycle, log });
  const handle = host.handlers.generationChanged as Handler;

  await handle(
    change('activated', owner(1, 2), owner(1, 2), [live(1, 'active', 2)]),
    {},
  );
  assert.deepEqual(host.calls, [`recoverWith ${JSON.stringify([])}`]);
});

void test('a failed generation activates no runtime: it recovers nothing', async () => {
  const host = fakes();

  installHandover({ services: host.services, lifecycle: host.lifecycle, log });
  const handle = host.handlers.generationChanged as Handler;

  await handle(
    change('activated', owner(2), owner(2), [
      live(1, 'draining'),
      live(2, 'failed'),
    ]),
    {},
  );
  await turn();
  assert.deepEqual(host.calls, []);
});

void test('a peer signal of another bundle, or a runtime that is not active, adopts nothing', async () => {
  const host = fakes();

  installHandover({ services: host.services, lifecycle: host.lifecycle, log });
  const peer = host.handlers.peerSignal as Handler;

  await peer(
    {
      topic: 'runtime.released',
      payload: {},
      from: { bundleId: 'other', generation: 1, incarnation: 1 },
      self: owner(2),
      live: [live(2, 'active')],
    },
    {},
  );
  await peer(
    {
      topic: 'runtime.released',
      payload: {},
      from: { bundleId: 'runtime', generation: 2, incarnation: 1 },
      self: owner(1),
      live: [live(1, 'draining'), live(2, 'active')],
    },
    {},
  );
  assert.deepEqual(host.calls, []);
});

void test('the start step reconciles at its stage and logs the workspace it found', async () => {
  const host = fakes();

  installStartStop({ services: host.services, lifecycle: host.lifecycle });
  await (host.handlers.start as Handler)({}, {});

  assert.deepEqual(host.stages, ['workspace_reconciliation']);
  assert.deepEqual(
    host.lines.map(({ message }) => message),
    ['Reconciling persisted projects and threads', 'Workspace reconciled'],
  );
  assert.deepEqual(host.lines[1]?.fields, {
    interruptedThreads: 1,
    interruptedProjects: 2,
  });
  assert.deepEqual(host.calls, ['recover']);
});

void test('the stop step disposes the runtime', async () => {
  const host = fakes();

  installStartStop({ services: host.services, lifecycle: host.lifecycle });
  await (host.handlers.stop as Handler)({}, {});

  assert.deepEqual(host.calls, ['dispose']);
});
