// The runtime's client part activates without the host (bundle isolation
// phase 3, T3.6): it provides `runtime.records/v1` and nothing else on the
// client, and calls no method of `runtime/v1` or `runtime.threads/v1` until a
// read or a `follow` asks.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { checkRecording, recordActivation } from 'bundle';
import type {
  ClientContext,
  ConnectionStatus,
  Disposable,
  Services,
} from 'bundle/contracts';
import { manifestV1Schema } from 'bundle/runtime';

import { activate } from '../../src/client/index.js';

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

void test('activation with an unreachable host calls no host method', async () => {
  const hostCalls: string[] = [];
  const provided: string[] = [];
  /** A host contract whose every method is recorded and rejects as unreachable. */
  const unreachable = (contract: string) =>
    new Proxy(Object.create(null) as object, {
      get: (_target, property) =>
        typeof property === 'string' && property !== 'then'
          ? () => {
              hostCalls.push(`${contract}.${property}`);
              return Promise.reject(new Error('The host cannot be reached.'));
            }
          : undefined,
    });
  const connection = {
    status: (): ConnectionStatus => 'disconnected',
    subscribe: (): Disposable => ({ dispose: () => undefined }),
  };
  const services = {
    provide: (definition: { readonly id: string }): Disposable => {
      provided.push(definition.id);
      return { dispose: () => undefined };
    },
    use: (contract: { readonly id: string }) =>
      contract.id === 'doric.connection/v1'
        ? connection
        : unreachable(contract.id),
    whenAvailable: (): Disposable => ({ dispose: () => undefined }),
  } as unknown as Services;

  const cleanup = await activate({ services } as unknown as ClientContext);

  assert.deepEqual(hostCalls, []);
  assert.deepEqual(provided, ['runtime.records/v1']);
  if (typeof cleanup === 'function') await cleanup();
  assert.deepEqual(hostCalls, []);
});
