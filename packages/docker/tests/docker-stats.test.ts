import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';

import {
  createDockerClient,
  type DockerResponse,
  type DockerTransportRequest,
} from '../src/index.js';
import { dockerStatsFrom } from '../src/lib/mapping.js';

const jsonResponse = (status: number, body: unknown): DockerResponse => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(body)),
});

void test('derives container CPU as a share of its own quota', () => {
  const raw = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 12_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 10_000_000_000,
    },
  };

  // The container burned two host cores worth of CPU time. Against its own
  // two-core quota that is its whole allotment; against four cores it is half.
  assert.equal(dockerStatsFrom(raw, 2).cpuPercent, 100);
  assert.equal(dockerStatsFrom(raw, 4).cpuPercent, 50);
});

void test('omits the container CPU reading when the quota is unknown', () => {
  const raw = {
    cpu_stats: {
      cpu_usage: { total_usage: 2_000_000_000 },
      system_cpu_usage: 12_000_000_000,
      online_cpus: 4,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 10_000_000_000,
    },
  };

  assert.equal(dockerStatsFrom(raw).cpuPercent, undefined);
});

void test('falls back to the per-cpu length when online_cpus is absent', () => {
  const raw = {
    cpu_stats: {
      cpu_usage: {
        total_usage: 2_000_000_000,
        percpu_usage: [1, 2, 3, 4],
      },
      system_cpu_usage: 12_000_000_000,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1_000_000_000 },
      system_cpu_usage: 10_000_000_000,
    },
  };

  assert.equal(dockerStatsFrom(raw, 4).cpuPercent, 50);
});

void test('subtracts reclaimable page cache from used memory on cgroup v2', () => {
  const stats = dockerStatsFrom({
    memory_stats: {
      usage: 100_000_000,
      limit: 268_435_456,
      stats: { inactive_file: 20_000_000 },
    },
  });

  assert.equal(stats.memoryUsedBytes, 80_000_000);
  assert.equal(stats.memoryLimitBytes, 268_435_456);
});

void test('subtracts cache from used memory on cgroup v1', () => {
  const stats = dockerStatsFrom({
    memory_stats: {
      usage: 100_000_000,
      limit: 268_435_456,
      stats: { cache: 25_000_000 },
    },
  });

  assert.equal(stats.memoryUsedBytes, 75_000_000);
});

void test('reads one-shot stats through the container stats endpoint', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      return jsonResponse(200, {
        cpu_stats: {
          cpu_usage: { total_usage: 2_000_000_000 },
          system_cpu_usage: 12_000_000_000,
          online_cpus: 4,
        },
        precpu_stats: {
          cpu_usage: { total_usage: 1_000_000_000 },
          system_cpu_usage: 10_000_000_000,
        },
        memory_stats: {
          usage: 100_000_000,
          limit: 268_435_456,
          stats: { inactive_file: 20_000_000 },
        },
      });
    },
  });

  const stats = await client.stats('sandbox-1', { cpuCount: 2 });

  assert.equal(requests[0]?.method, 'GET');
  assert.equal(requests[0]?.path, '/containers/sandbox-1/stats');
  assert.deepEqual(requests[0]?.query, { stream: false, 'one-shot': true });
  assert.equal(stats.cpuPercent, 100);
  assert.equal(stats.memoryUsedBytes, 80_000_000);
  assert.equal(stats.memoryLimitBytes, 268_435_456);
});

void test('provisioned runtime serves a timestamped reading', async () => {
  const requests: DockerTransportRequest[] = [];

  const client = createDockerClient({
    request: async (request) => {
      requests.push(request);

      if (request.path === '/containers/create') {
        return jsonResponse(201, { Id: 'sandbox-1' });
      }

      if (request.path === '/containers/sandbox-1/stats') {
        return jsonResponse(200, {
          memory_stats: { usage: 100_000_000, limit: 268_435_456 },
        });
      }

      return {
        status: request.path === '/images/create' ? 200 : 204,
        headers: {},
        body: new Uint8Array(),
      };
    },
  });

  const runtime = await client.provision({
    image: 'node:22-slim',
    root: '/workspace',
    resources: { cpuCount: 2, memoryMiB: 768, diskMiB: 4096 },
    network: { mode: 'disabled', ssh: false },
  });

  const stats = await runtime.stats?.();

  assert.ok(stats);
  assert.equal(stats.cpuCount, 2);
  assert.equal(stats.memoryUsedBytes, 100_000_000);
  assert.equal(stats.memoryLimitBytes, 268_435_456);
  assert.equal(Number.isNaN(Date.parse(stats.at)), false);

  await runtime.dispose();
});
