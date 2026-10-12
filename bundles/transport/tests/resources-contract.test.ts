import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { defineMethod, defineService } from 'bundle/contracts';
import { createMinimalHooks, createTestServices } from 'bundle/testing';
import express from 'express';
import { pino } from 'pino';
import {
  type HostResources,
  ResourcesV1,
  resourcesMethods,
} from 'resources/contracts';
import { Server as SocketServer } from 'socket.io';

import { createTransport, transportRequires } from '../src/kernel.js';

/*
 * The transport's own contracts after the stage-10 host switch: it provides
 * none (`resources/v1` is the `resources` bundle's), and the feature
 * contracts its routes call stay out of its `requires`, so a composition
 * without one of those bundles, or with one disabled, keeps the structural
 * transport. The routes reach them through the `features` services the
 * kernel passes, the platform's, as the desktop bridge does.
 */

const reading: HostResources = {
  at: '2026-01-01T00:00:00.000Z',
  cpuCount: 8,
  loadAverage: 1.5,
  memoryTotalBytes: 4096,
  memoryUsedBytes: 2048,
  uptimeSeconds: 3600,
};

void test('the transport provides no contract and requires no feature contract', () => {
  const bundle = createTransport({
    app: express(),
    io: new SocketServer(),
    logger: pino({ enabled: false }),
  });
  assert.deepEqual(bundle.manifest.provides, []);
  assert.deepEqual(bundle.descriptor.contracts, []);
  for (const feature of [
    'files/v1',
    'git.commands/v1',
    'usage/v1',
    'resources/v1',
    'terminal/v1',
  ])
    assert.ok(
      !transportRequires.some((entry) => entry.startsWith(`${feature}@`)),
      feature,
    );
});

void test('the feature routes call the services the kernel passes as features', async (t) => {
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);
  // The platform side, the only one that provides resources/v1 here.
  const platform = createTestServices({
    bundle: { id: 'platform' },
    provide: [
      defineService(ResourcesV1.id, {
        host: defineMethod({
          ...resourcesMethods.host,
          execute: async () => reading,
        }),
        project: defineMethod({
          ...resourcesMethods.project,
          execute: async () => ({ status: 'pending' as const }),
        }),
      }),
    ],
  });
  const own = createTestServices({
    bundle: { id: 'transport' },
    provide: [createMinimalHooks()],
  });
  const bundle = createTransport({
    app,
    io,
    logger: pino({ enabled: false }),
    features: () => platform.services,
  });
  const cleanup = await bundle.host?.activate({ services: own.services });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  t.after(async () => {
    if (typeof cleanup === 'function') await cleanup();
    await own.dispose();
    await platform.dispose();
    await io.close();
  });

  const response = await fetch(
    `http://127.0.0.1:${String(address.port)}/resources`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), reading);
});
