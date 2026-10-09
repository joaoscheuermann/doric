import assert from 'node:assert/strict';
import test from 'node:test';

import { AppHooksV1, HooksV1 } from 'bundle/contracts';

import { boot, core, errorKinds, probe, states } from './support/host.js';

const usesHooks = ['hooks/v1@^1.0.0'];

void test('onActivateHook sees every later activation in order; a failing handler only reaches diagnostics', async () => {
  const seen: string[] = [];
  const host = await boot([
    await core({ hooks: { deadlineMs: 30 } }),
    probe('observer', {
      requires: usesHooks,
      activate: ({ services }) => {
        services
          .use(HooksV1)
          .use(AppHooksV1)
          .onActivateHook(({ bundleId, environment }) => {
            seen.push(`${bundleId}@${environment}`);
          });
      },
    }),
    probe('thrower', {
      requires: usesHooks,
      activate: ({ services }) => {
        services
          .use(HooksV1)
          .use(AppHooksV1)
          .onActivateHook(() => {
            throw new Error('handler broke');
          });
      },
    }),
    probe('waiter', {
      requires: usesHooks,
      activate: ({ services }) => {
        services
          .use(HooksV1)
          .use(AppHooksV1)
          .onActivateHook(() => new Promise(() => undefined));
      },
    }),
    probe('zlast'),
  ]);

  try {
    assert.deepEqual(seen, [
      'observer@host',
      'thrower@host',
      'waiter@host',
      'zlast@host',
    ]);
    assert.deepEqual(states(host.platform), {
      core: 'active',
      observer: 'active',
      thrower: 'active',
      waiter: 'active',
      zlast: 'active',
    });

    const errors = errorKinds(host.platform);

    assert.ok(errors.includes('thrower:hook_handler_failed'));
    assert.ok(errors.includes('waiter:hook_handler_timeout'));
  } finally {
    await host.close();
  }
});

void test('ready fires onHostReadyHook once and stop fires onDeactivateHook in reverse order', async () => {
  const events: string[] = [];
  const host = await boot([
    await core(),
    probe('alpha', {
      requires: usesHooks,
      activate: ({ services }) => {
        const hooks = services.use(HooksV1).use(AppHooksV1);

        hooks.onHostReadyHook(() => {
          events.push('ready');
        });
        hooks.onDeactivateHook(({ bundleId }) => {
          events.push(`deactivate:${bundleId}`);
        });
      },
    }),
    probe('beta'),
  ]);

  await host.platform.ready();
  await host.platform.ready();
  assert.deepEqual(events, ['ready']);

  await host.close();
  assert.deepEqual(events, ['ready', 'deactivate:beta', 'deactivate:alpha']);
});
