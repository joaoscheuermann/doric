// The window's screen call: every attach resolves the contract bound to the
// Project's scope — what `runtime.lease/v1` reads on the host — the identifier
// is validated before any call, and a failed bridge answers one sentence.

import assert from 'node:assert/strict';
import test from 'node:test';

import { ContractError } from 'bundle/contracts';

import { createScreenApi, screenApiMessages } from '../src/client/api.js';
import type { ScreenAttach } from '../src/contracts/index.js';

const ready = (projectId: string): ScreenAttach => ({
  status: 'ready',
  url: `http://127.0.0.1:5555/screen/${projectId}/`,
  display: ':100',
});

test('attach resolves the contract bound to the Project scope', async () => {
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

test('each attach of a Project resolves its own scope', async () => {
  const scopes: string[] = [];
  const api = createScreenApi((projectId) => {
    scopes.push(projectId);

    return { attach: async (id) => ready(id) };
  });

  await api.attach('p1');
  await api.attach('p2');

  assert.deepEqual(scopes, ['p1', 'p2']);
});

test('an invalid identifier never reaches the host', async () => {
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

test('a lost bridge answers the sentence the panel shows', async () => {
  const api = createScreenApi(() => ({
    attach: async () => {
      throw new ContractError('unavailable', 'the bridge is gone');
    },
  }));

  await assert.rejects(
    api.attach('p1'),
    new RegExp(screenApiMessages.unavailable),
  );
});

test('any other failure answers the generic sentence', async () => {
  const api = createScreenApi(() => ({
    attach: async () => {
      throw new Error('boom');
    },
  }));

  await assert.rejects(
    api.attach('p1'),
    new RegExp(screenApiMessages.screenFailed),
  );
});
