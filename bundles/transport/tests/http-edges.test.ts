import assert from 'node:assert/strict';
import test from 'node:test';

import type { HostResources } from 'resources/contracts';

import { serve } from './support/host.js';

/*
 * The edges of the HTTP surface that no single route owns (design 57 §8.2):
 * the mount order and what it implies, the JSON parser's failures, the final
 * error handler, and Express's own answer to an unknown route.
 */

const projectId = '018f47d2-e3b1-7b4f-8b2c-1f5a7fdf1601';
const snapshot = {
  configuration: {
    providers: [],
    models: { execution: { providerId: 'p', model: 'm' } },
    execution: { maxTurns: 1 },
  },
  revision: 1,
  updatedAt: '',
};

void test('every route after the terminal router answers without caching', async (t) => {
  const host = await serve({
    configuration: { current: () => snapshot },
    runtime: { project: () => undefined },
    secrets: { list: () => [] },
  });
  t.after(host.close);
  // The terminal router is mounted first, at the root, and marks every
  // request that passes through it, including those of later routers.
  for (const path of ['/config', '/credentials', `/projects/${projectId}`]) {
    const response = await host.request(path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
});

void test('answers a malformed JSON body through the final error handler', async (t) => {
  const host = await serve();
  t.after(host.close);
  for (const path of ['/projects', '/credentials', '/providers/models']) {
    const response = await fetch(`${host.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
    });
    assert.equal(response.status, 500, path);
    assert.deepEqual(await response.json(), {
      error: {
        code: 'internal_error',
        message: 'The request could not be completed.',
      },
    });
  }
});

void test('answers an unknown route with the default Express page', async (t) => {
  const host = await serve();
  t.after(host.close);
  const response = await host.request('/unknown');
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await response.text(), /Cannot GET \/unknown/);
});

void test('validates resource ids per router, and nowhere else', async (t) => {
  const host = await serve({
    terminal: { snapshot: () => undefined },
    sandbox: { machine: () => undefined },
  });
  t.after(host.close);
  for (const [path, method, code] of [
    ['/projects/not-an-id', 'GET', 'invalid_project_id'],
    ['/threads/not-an-id', 'GET', 'invalid_thread_id'],
    ['/credentials/not-an-id', 'DELETE', 'invalid_credential_id'],
  ] as const) {
    const response = await host.request(path, method);
    assert.equal(response.status, 400, path);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      code,
    );
  }
  // Terminal and VM ids are not UUIDs, so their routers check none.
  assert.equal((await host.request('/terminals/not-an-id')).status, 404);
  assert.equal((await host.request('/vms/not-an-id/ssh')).status, 404);
});

void test('answers an escaped provider failure without its message', async (t) => {
  const host = await serve({
    runtime: {
      projects: () => {
        throw new Error('private database error');
      },
    },
    sandbox: {
      machines: () => {
        throw new Error('private sandbox error');
      },
    },
  });
  t.after(host.close);
  for (const path of ['/projects', '/vms']) {
    const response = await host.request(path);
    assert.equal(response.status, 500);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), {
      error: {
        code: 'internal_error',
        message: 'The request could not be completed.',
      },
    });
    assert.doesNotMatch(body, /private/);
  }
});

void test('serves the host machine reading of resources/v1 without caching', async (t) => {
  const resources: HostResources = {
    at: '2026-01-01T00:00:00.000Z',
    cpuCount: 8,
    cpuPercent: 12,
    loadAverage: 1.5,
    memoryTotalBytes: 4096,
    memoryUsedBytes: 2048,
    uptimeSeconds: 3600,
  };
  const host = await serve({ resources: { host: () => resources } });
  t.after(host.close);
  const response = await host.request('/resources');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), resources);
});
