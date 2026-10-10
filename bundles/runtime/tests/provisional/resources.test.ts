import assert from 'node:assert/strict';
import test from 'node:test';

import type { Sandbox, SandboxStats } from 'sandbox';

import { readSandboxResources } from '../../src/host/provisional/resources.js';

/*
 * The sandbox half of agents/doric tests/resources.test.ts (design 57
 * §13.2); the host half is the transport's.
 */

const sandboxReading = (stats: () => Promise<SandboxStats | undefined>) =>
  ({ stats }) as unknown as Sandbox;

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
