import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hostResourcesSchema,
  projectResourcesOutcomeSchema,
  ResourcesV1,
  resourcesMethods,
} from '../src/contracts/index.js';

/*
 * resources/v1: the `GET /resources` body and the Project container reading
 * as serializable contract answers.
 */

void test('resources/v1 is the host() and project() reads with no input', () => {
  assert.equal(ResourcesV1.id, 'resources/v1');
  assert.deepEqual(Object.keys(resourcesMethods), ['host', 'project']);
  assert.deepEqual(resourcesMethods.host.input.parse([]), []);
  assert.deepEqual(resourcesMethods.project.input.parse([]), []);
});

void test('a first reading has no CPU percent and a later one does', () => {
  const first = {
    at: '2026-01-01T00:00:00.000Z',
    cpuCount: 8,
    loadAverage: 0.5,
    memoryTotalBytes: 1024,
    memoryUsedBytes: 512,
    uptimeSeconds: 60,
  };
  assert.deepEqual(hostResourcesSchema.parse(first), first);
  assert.deepEqual(hostResourcesSchema.parse({ ...first, cpuPercent: 12.5 }), {
    ...first,
    cpuPercent: 12.5,
  });
});

void test('a reading with a missing or extra field is refused', () => {
  const { cpuCount: _cpuCount, ...withoutCpus } = {
    at: '',
    cpuCount: 1,
    memoryTotalBytes: 1,
    memoryUsedBytes: 1,
    uptimeSeconds: 1,
  };
  assert.equal(hostResourcesSchema.safeParse(withoutCpus).success, false);
  assert.equal(
    hostResourcesSchema.safeParse({
      ...withoutCpus,
      cpuCount: 1,
      hostname: 'leak',
    }).success,
    false,
  );
});

void test('a Project reading is a container on the lease, or the lease state', () => {
  const container = { status: 'unavailable', at: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(
    projectResourcesOutcomeSchema.parse({ status: 'ready', value: container }),
    { status: 'ready', value: container },
  );
  for (const status of ['pending', 'unavailable', 'expired', 'missing']) {
    assert.deepEqual(projectResourcesOutcomeSchema.parse({ status }), {
      status,
    });
  }
  assert.equal(
    projectResourcesOutcomeSchema.safeParse({ status: 'ready' }).success,
    false,
  );
  assert.equal(
    projectResourcesOutcomeSchema.safeParse({ status: 'inactive' }).success,
    false,
  );
});
