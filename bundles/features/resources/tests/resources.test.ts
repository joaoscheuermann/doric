// resources/v1 (§3.12) and the window's reads over it, from slice S65d: the
// machine and the Project's container arrive through the generated
// `ResourcesService` client, and are observed as the REST client answered:
// lease states are data, `pending` carries `Retry-After: 1`, a failed call is
// a sentence. The host part itself (the Stats widening, the lease states and
// the failures behind them) is `tests/router.test.ts`; the only host-part case
// kept here is the CPU-share arithmetic the window's gauges take from it.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ServiceImpl } from '@connectrpc/connect';
import { ContractError } from 'bundle/contracts';

import {
  createResourcesReads,
  resourcesHostOf,
} from '../src/client/api/resources.js';
import { ResourcesService } from '../src/contracts/gen/doric/resources/v1/resources_pb.js';
import { cpuPercentBetween } from '../src/host/index.js';
import { resourcesWindow } from './support/resources-connect.js';

test('reads the busy share of every core between two samples', () => {
  assert.equal(
    cpuPercentBetween([{ idle: 100, total: 200 }], [{ idle: 150, total: 300 }]),
    50,
  );
  assert.equal(
    cpuPercentBetween([{ idle: 0, total: 100 }], [{ idle: 0, total: 100 }]),
    undefined,
  );
});

describe("the window's resource reads over resources/v1", () => {
  /** The window's reads over a host that answers `impl`. */
  const readsOver = (impl: Partial<ServiceImpl<typeof ResourcesService>>) => {
    const window = resourcesWindow(impl);

    return {
      window,
      reads: createResourcesReads(resourcesHostOf(window.services)),
    };
  };

  test('read the machine and the container, on the Project scope the container needs', async () => {
    const { window, reads } = readsOver({
      host: () => ({
        at: '2026-01-01T00:00:00.000Z',
        cpuCount: 4,
        memoryTotalBytes: 100,
        memoryUsedBytes: 50,
        uptimeSeconds: 9,
      }),
      project: () => ({
        status: 'ready',
        value: {
          status: 'ready',
          at: '2026-01-01T00:00:00.000Z',
          cpuPercent: 25,
          cpuCount: 2,
          memoryUsedBytes: 5,
          memoryLimitBytes: 10,
        },
      }),
    });

    const host = await reads.host();
    assert.equal(host.cpuCount, 4);
    assert.equal(host.memoryUsedBytes, 50);

    const project = await reads.project('p-1');
    assert.ok(project.status === 'ready');
    assert.deepEqual(project.container, {
      status: 'ready',
      at: '2026-01-01T00:00:00.000Z',
      cpuPercent: 25,
      cpuCount: 2,
      memoryUsedBytes: 5,
      memoryLimitBytes: 10,
    });

    assert.deepEqual(
      window.calls.map(({ method, scope }) => [method, scope]),
      [
        [`${ResourcesService.typeName}/Host`, undefined],
        [`${ResourcesService.typeName}/Project`, { projectId: 'p-1' }],
      ],
    );
  });

  test('answer the lease state with the route hint, and an unmeasured container as unavailable', async () => {
    for (const state of [
      'pending',
      'unavailable',
      'expired',
      'missing',
    ] as const) {
      const { reads } = readsOver({ project: () => ({ status: state }) });

      assert.deepEqual(
        await reads.project('p-1'),
        state === 'pending'
          ? { status: 'pending', retryAfterSeconds: 1 }
          : { status: state },
      );
    }

    const { reads } = readsOver({
      project: () => ({
        status: 'ready',
        value: { status: 'unavailable', at: 'p' },
      }),
    });
    assert.deepEqual(await reads.project('p-1'), {
      status: 'ready',
      container: { status: 'unavailable', at: 'p' },
    });
  });

  test('refuse an invalid Project identifier before calling the host', async () => {
    const { window, reads } = readsOver({
      project: () => ({ status: 'pending' }),
    });

    for (const id of ['', 'x'.repeat(201), 'a\0b']) {
      await assert.rejects(reads.project(id), {
        message: 'The item identifier is invalid.',
      });
    }
    assert.deepEqual(window.calls, []);
  });

  test('show the REST sentences when the host call fails', async () => {
    const lost = readsOver({
      host: () => {
        throw new ContractError('disconnected', 'bridge lost');
      },
    });
    await assert.rejects(lost.reads.host(), {
      message: 'Doric backend is unavailable.',
    });

    const invalid = readsOver({
      project: () => {
        throw new ContractError('invalid_output', 'bad answer');
      },
    });
    await assert.rejects(invalid.reads.project('p-1'), {
      message: 'Doric returned an invalid response.',
    });

    const other = readsOver({
      project: () => {
        throw new Error('boom');
      },
    });
    await assert.rejects(other.reads.project('p-1'), {
      message: 'The request could not be completed.',
    });
  });
});
