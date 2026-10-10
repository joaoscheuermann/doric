import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { createTestServices } from 'bundle/testing';
import express from 'express';
import { pino } from 'pino';
import { ResourcesV1 } from 'resources/contracts';
import { Server as SocketServer } from 'socket.io';

import { createTransport, type HostResources } from '../src/kernel.js';

/*
 * resources/v1 (stage 9 WP-H): the kernel-embedded transport provides the
 * `GET /resources` reading as a contract, so a desktop window reads the host
 * machine over the bridge. The route and the contract share one reader.
 */

const reading = (cpuPercent?: number): HostResources => ({
  at: '2026-01-01T00:00:00.000Z',
  cpuCount: 8,
  ...(cpuPercent === undefined ? {} : { cpuPercent }),
  loadAverage: 1.5,
  memoryTotalBytes: 4096,
  memoryUsedBytes: 2048,
  uptimeSeconds: 3600,
});

const activateTransport = async (read: () => HostResources) => {
  const app = express();
  const server = createServer(app);
  const io = new SocketServer(server);
  const bundle = createTransport({
    app,
    io,
    logger: pino({ enabled: false }),
    readHostResources: read,
  });
  const services = createTestServices({ bundle: { id: 'transport' } });
  const cleanup = await bundle.host?.activate({ services: services.services });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return {
    bundle,
    resources: services.services.use(ResourcesV1),
    route: async () =>
      (
        await fetch(`http://127.0.0.1:${String(address.port)}/resources`)
      ).json(),
    close: async () => {
      if (typeof cleanup === 'function') await cleanup();
      await services.dispose();
      await io.close();
    },
  };
};

void test('the transport declares resources/v1 as its only, remote-callable contract', () => {
  const bundle = createTransport({
    app: express(),
    io: new SocketServer(),
    logger: pino({ enabled: false }),
  });
  assert.deepEqual(bundle.manifest.provides, ['resources/v1@1.0.0']);
  assert.deepEqual(bundle.descriptor.contracts, [
    {
      id: 'resources/v1',
      version: '1.0.0',
      kind: 'service',
      environment: 'host',
      cardinality: 'one',
      local: false,
      schema: 'schemas/resources/v1.json',
    },
  ]);
});

void test('resources/v1.host() answers what GET /resources answers, from one CPU sample', async (t) => {
  const readings = [reading(), reading(25)];
  let reads = 0;
  const host = await activateTransport(() => {
    const value = readings[reads] ?? reading(50);
    reads += 1;
    return value;
  });
  t.after(host.close);
  // The first reading of the process has no CPU percent, whoever asks first.
  assert.deepEqual(await host.resources.host(), reading());
  assert.deepEqual(await host.route(), reading(25));
  assert.equal(reads, 2);
});
