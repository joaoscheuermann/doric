import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import express from 'express';
import type { Sandbox, SandboxStats } from 'sandbox';

import {
  cpuPercentBetween,
  type HostResources,
  readSandboxResources,
} from '../src/lib/workspace/resources.js';
import { createResourcesRouter } from '../src/routes/resources.js';

const sandboxReading = (stats: () => Promise<SandboxStats | undefined>) =>
  ({ stats }) as unknown as Sandbox;

void test('reads the busy share of every core between two samples', () => {
  assert.equal(
    cpuPercentBetween([{ idle: 100, total: 200 }], [{ idle: 150, total: 300 }]),
    50,
  );
});

void test('answers nothing when the counters did not advance', () => {
  assert.equal(
    cpuPercentBetween([{ idle: 0, total: 100 }], [{ idle: 0, total: 100 }]),
    undefined,
  );
});

void test('translates a provider reading into container resources', async () => {
  const at = new Date('2026-01-01T00:00:00.000Z');
  const result = await readSandboxResources(
    sandboxReading(async () => ({
      cpuPercent: 25,
      cpuCount: 2,
      memoryUsedBytes: 1024,
      memoryLimitBytes: 2048,
      at: 'provider-time',
    })),
    at,
  );
  assert.deepEqual(result, {
    status: 'ready',
    at: at.toISOString(),
    cpuPercent: 25,
    cpuCount: 2,
    memoryUsedBytes: 1024,
    memoryLimitBytes: 2048,
  });
});

void test('answers unavailable when a provider offers no reading', async () => {
  const at = new Date('2026-01-01T00:00:00.000Z');
  const result = await readSandboxResources(
    sandboxReading(async () => undefined),
    at,
  );
  assert.deepEqual(result, { status: 'unavailable', at: at.toISOString() });
});

void test('answers unavailable when a provider fails', async () => {
  const at = new Date('2026-01-01T00:00:00.000Z');
  const result = await readSandboxResources(
    sandboxReading(async () => {
      throw new Error('provider unavailable');
    }),
    at,
  );
  assert.deepEqual(result, { status: 'unavailable', at: at.toISOString() });
});

void test('serves the machine reading the host injects', async () => {
  const resources: HostResources = {
    at: '2026-01-01T00:00:00.000Z',
    cpuCount: 8,
    cpuPercent: 12,
    loadAverage: 1.5,
    memoryTotalBytes: 4096,
    memoryUsedBytes: 2048,
    uptimeSeconds: 3600,
  };
  const app = express();
  app.use(
    '/resources',
    createResourcesRouter(() => resources),
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/resources`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), resources);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
