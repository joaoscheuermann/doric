// The runtime's client part activates without the host (bundle isolation
// phase 3, T3.6): it provides `runtime.records/v1` and nothing else on the
// client, and calls no method of `runtime/v2` or `runtime.threads/v1` until a
// read or a `follow` asks. Bundle isolation step 7(a): the client reads the
// host's Projects through `runtime/v2`, and reaches the host through no other
// contract than it and `runtime.threads/v1`. Slice S65a: both are the
// generated clients of `RuntimeService` and `ThreadsService` over the window's
// Connect path (`ClientServices.use(<X>Service)`), not envelope host contracts.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { checkRecording, recordActivation } from 'bundle';
import type {
  ClientContext,
  ConnectionStatus,
  Disposable,
} from 'bundle/contracts';
import { manifestV1Schema } from 'bundle/runtime';

import { activate } from '../../src/client/index.js';
import { ThreadsService } from '../../src/contracts/gen/doric/runtime/threads/v1/threads_pb.js';
import { RuntimeService } from '../../src/contracts/gen/doric/runtime/v2/runtime_pb.js';
import type { RecordsRead } from '../../src/contracts/index.js';
import {
  fakeClientServices,
  fakeHostClients,
  settle,
} from './support/connect.js';

const manifest = async () =>
  manifestV1Schema.parse(
    JSON.parse(await readFile('bundles/runtime/runtime/manifest.json', 'utf8')),
  );

void test('the client part provides only runtime.records/v1', async () => {
  const recorded = await recordActivation({
    manifest: await manifest(),
    environment: 'client',
    activate: activate as Parameters<typeof recordActivation>[0]['activate'],
  });

  // The host part records every other provided contract; check the client
  // part against its own one.
  const full = await manifest();
  const clientOnly = {
    ...full,
    provides: full.provides.filter((entry) =>
      entry.startsWith('runtime.records/v1@'),
    ),
  };

  assert.deepEqual(checkRecording(clientOnly, recorded), []);
  assert.deepEqual(
    recorded.map(({ id, environment, kind }) => ({ id, environment, kind })),
    [{ id: 'runtime.records/v1', environment: 'client', kind: 'service' }],
  );
});

const PROJECT = '00000000-0000-4000-8000-000000000001';

void test('activation with an unreachable host calls no host method', async () => {
  // A host that serves nothing: every call would fail.
  const host = fakeHostClients(() => undefined);
  const window = fakeClientServices({
    bundleId: 'runtime',
    hostClients: host.hostClients,
    connection: {
      status: (): ConnectionStatus => 'disconnected',
      subscribe: (): Disposable => ({ dispose: () => undefined }),
    },
  });

  const cleanup = await activate({
    services: window.services,
  } as unknown as ClientContext);
  await settle();

  assert.deepEqual(host.calls, []);
  assert.deepEqual(
    window.provided.map(({ id }) => id),
    ['runtime.records/v1'],
  );
  assert.deepEqual(window.envelope, [], 'no host contract on the envelope');
  if (typeof cleanup === 'function') await cleanup();
  assert.deepEqual(host.calls, []);
});

void test('a Projects read reaches the host through RuntimeService and ThreadsService only', async () => {
  const host = fakeHostClients((router) => {
    router.service(RuntimeService, {
      projects: () => ({
        items: [
          {
            id: PROJECT,
            name: 'Checkout',
            state: 'ready',
            configRevision: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      }),
      projectActivity: () => ({ projectActivity: [] }),
    });
    router.service(ThreadsService, {});
  });
  const window = fakeClientServices({
    bundleId: 'runtime',
    hostClients: host.hostClients,
  });

  const cleanup = await activate({
    services: window.services,
  } as unknown as ClientContext);
  const records = window.provided.find(({ id }) => id === 'runtime.records/v1');
  assert.ok(records !== undefined);
  const { projects } = records.methods as {
    readonly projects: { execute(input: undefined): unknown };
  };
  projects.execute(undefined);
  await settle();

  const methods = host.calls.map(({ method }) => method);
  assert.ok(
    methods.includes('doric.runtime.v2.RuntimeService/Projects'),
    methods.join(', '),
  );
  assert.deepEqual(
    methods.filter(
      (method) =>
        !method.startsWith('doric.runtime.v2.RuntimeService/') &&
        !method.startsWith('doric.runtime.threads.v1.ThreadsService/'),
    ),
    [],
  );
  assert.deepEqual(
    [...new Set(host.calls.map(({ part }) => part))],
    ['runtime'],
  );
  assert.deepEqual(window.envelope, [], 'no host contract on the envelope');

  // The read answers the host's Project as `runtime.records/v1` shows it.
  const read = projects.execute(undefined) as RecordsRead<readonly unknown[]>;
  assert.equal(read.status, 'ready');
  assert.deepEqual(read.value, [
    {
      id: PROJECT,
      name: 'Checkout',
      state: 'ready',
      configRevision: 2,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
  ]);
  if (typeof cleanup === 'function') await cleanup();
});
