// The window's screen call: every attach resolves the contract bound to the
// Project's scope — what `runtime.lease/v1` reads on the host — the identifier
// is validated before any call, and everything that is not a status reads as
// "no answer", which the desktop part shows as a retryable failure.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import { createScreenApi, screenApiMessages } from '../src/client/api.js';
import type { ScreenAttach } from '../src/contracts/index.js';

const ready = (projectId: string): ScreenAttach => ({
  status: 'ready',
  path: `/screen/${projectId}/`,
  display: ':100',
});

void test('attach resolves the contract bound to the Project scope', async () => {
  const scopes: string[] = [];
  const calls: string[] = [];
  const api = createScreenApi((projectId) => {
    scopes.push(projectId);

    return {
      attach: async (id) => {
        calls.push(id);

        return ready(id);
      },
    };
  });

  const answer = await api.attach('p1');

  assert.deepEqual(scopes, ['p1']);
  assert.deepEqual(calls, ['p1']);
  assert.deepEqual(answer, ready('p1'));
});

void test('each attach of a Project resolves its own scope', async () => {
  const scopes: string[] = [];
  const api = createScreenApi((projectId) => {
    scopes.push(projectId);

    return { attach: async (id) => ready(id) };
  });

  await api.attach('p1');
  await api.attach('p2');

  assert.deepEqual(scopes, ['p1', 'p2']);
});

void test('an invalid identifier never reaches the host', async () => {
  let resolutions = 0;
  const api = createScreenApi(() => {
    resolutions += 1;

    return { attach: async () => ready('p1') };
  });

  for (const value of ['', 'x'.repeat(201), 'a\0b']) {
    await assert.rejects(
      api.attach(value),
      new RegExp(screenApiMessages.invalidIdentifier),
    );
  }

  assert.equal(resolutions, 0);
});

void test('a lost bridge answers no answer', async () => {
  const api = createScreenApi(() => ({
    attach: async () => {
      throw new ContractError('unavailable', 'the bridge is gone');
    },
  }));

  assert.equal(await api.attach('p1'), null);
});

void test('any other failure answers no answer too', async () => {
  const api = createScreenApi(() => ({
    attach: async () => {
      throw new Error('boom');
    },
  }));

  assert.equal(await api.attach('p1'), null);
});

void test('an answer that is not a status is dropped', async () => {
  const api = createScreenApi(() => ({
    attach: async () =>
      ({ status: 'ready', url: 'http://127.0.0.1:1/' }) as never,
  }));

  assert.equal(await api.attach('p1'), null);
});
