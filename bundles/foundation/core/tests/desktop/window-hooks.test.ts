// The core's hooks/v1 provider binds doric.window.hooks/v1 handlers to the
// window of the call that registered them (stage 9, §4.7): executing the
// hooks for one window runs only that window's handlers. Exercised on the
// provider definition, as the runtime invokes it; a window's own directory
// always stamps its key, so a real window cannot show the filter.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type AnyHookHandler,
  type Call,
  DoricCatalogV1,
  DoricDiagnosticsV1,
  type Services,
  WindowHooksV1,
} from 'bundle/contracts';
import { createHopCall } from 'bundle/runtime';

import { createHooks } from '../../src/shared/hooks.js';

const caller = (bundleId: string) => ({
  bundleId,
  version: '1.0.0',
  generation: 1,
});

const signal = new AbortController().signal;

const inWindow = (bundleId: string, windowKey: string, deadline = 0): Call => {
  const call = createHopCall({
    caller: caller(bundleId),
    generationSignal: signal,
    arg: deadline > 0 ? { deadline } : undefined,
    defaultGeneration: 1,
  });

  return { ...call, scope: { ...call.scope, windowKey } };
};

/** The platform contracts the provider reads: catalog order and diagnostics. */
const services = {
  use: (ref: { readonly id: string }) => {
    if (ref.id === DoricCatalogV1.id) {
      return {
        get: () => ({ order: ['core', 'x'], generation: 1, bundles: [] }),
      };
    }

    if (ref.id === DoricDiagnosticsV1.id) {
      return { report: () => undefined };
    }

    throw new Error(`Unexpected use of ${ref.id}.`);
  },
} as unknown as Services;

void test("executing the window hooks of one window runs only that window's handlers", async () => {
  const { methods } = createHooks();
  const ran: string[] = [];

  methods.define.execute(
    WindowHooksV1,
    inWindow('doric', 'workspace'),
    services,
  );

  for (const key of ['workspace', 'settings']) {
    const close: AnyHookHandler = () => {
      ran.push(`close ${key}`);

      return { allow: true };
    };
    const flush: AnyHookHandler = () => {
      ran.push(`flush ${key}`);
    };

    methods.register.execute(
      [WindowHooksV1, 'onCloseHook', close],
      inWindow('x', key),
      services,
    );
    methods.register.execute(
      [WindowHooksV1, 'onFlushHook', flush],
      inWindow('x', key),
      services,
    );
  }

  await methods.execute.execute(
    [WindowHooksV1, 'onCloseHook', {}],
    inWindow('doric', 'settings'),
    services,
  );
  await methods.execute.execute(
    [WindowHooksV1, 'onFlushHook', {}],
    inWindow('doric', 'settings', Date.now() + 1_500),
    services,
  );

  assert.deepEqual(ran, ['close settings', 'flush settings']);
});
