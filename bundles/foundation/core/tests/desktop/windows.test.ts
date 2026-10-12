import assert from 'node:assert/strict';
import test from 'node:test';

import { type CallScope, HooksV1, WindowsV1 } from 'bundle/contracts';
import { CoreHooksV1 } from 'core/contracts';

import { bootDesktop, probe } from '../support/desktop.js';

const opener = (
  key: string,
  path: string,
  scope?: CallScope,
  failures: unknown[] = [],
) =>
  probe('graph', {
    requires: ['windows/v1@^1.0.0'],
    activate: async ({ services }) => {
      try {
        await services.use(WindowsV1, scope).open({ key, path });
      } catch (error) {
        failures.push(error);
      }
    },
  });

void test("windows/v1.open opens the window under the calling bundle's key", async () => {
  const desktop = await bootDesktop([opener('main', '/graph')]);

  try {
    assert.deepEqual(
      desktop.received('doric.windows/v1.open').map(({ input }) => input),
      [{ key: 'graph:main', path: '/graph' }],
    );
  } finally {
    await desktop.stop();
  }
});

void test('onBeforeOpenWindowHook sees the unprefixed request and the calling window, and may change all but the key', async () => {
  const seen: unknown[] = [];
  const adjuster = probe('adjuster', {
    requires: ['hooks/v1@^1.0.0', 'core.hooks/v1@^1.0.0'],
    activate: ({ services }) => {
      services
        .use(HooksV1)
        .use(CoreHooksV1)
        .onBeforeOpenWindowHook((request, call) => {
          seen.push({ request, windowKey: call.scope?.windowKey });

          return {
            ...request,
            key: 'stolen',
            path: `${request.path}/adjusted`,
            appearance: { titleBar: 'native', background: 'window' },
          };
        });
    },
  });
  const desktop = await bootDesktop([
    adjuster,
    opener('x', '/x', { windowKey: 'workspace' }),
  ]);

  try {
    assert.deepEqual(seen, [
      {
        request: { key: 'x', path: '/x' },
        windowKey: 'workspace',
      },
    ]);
    assert.deepEqual(
      desktop.received('doric.windows/v1.open').map(({ input }) => input),
      [
        {
          key: 'graph:x',
          path: '/x/adjusted',
          appearance: { titleBar: 'native', background: 'window' },
        },
      ],
    );
  } finally {
    await desktop.stop();
  }
});

void test('windows/v1.open refuses an empty key without reaching main', async () => {
  const failures: unknown[] = [];
  const desktop = await bootDesktop([opener('', '/x', undefined, failures)]);

  try {
    assert.equal((failures[0] as { code?: string }).code, 'invalid_input');
    assert.deepEqual(desktop.received('doric.windows/v1.open'), []);
  } finally {
    await desktop.stop();
  }
});
