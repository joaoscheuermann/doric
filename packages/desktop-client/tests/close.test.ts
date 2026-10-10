import assert from 'node:assert/strict';
import test from 'node:test';

import { HooksV1, WindowHooksV1 } from 'bundle/contracts';

import { activateClientBundles, wireClose } from '../src/index.js';
import {
  type ClientBundle,
  clientHooksBundle,
  describe,
  fakeDesktop,
  importerOf,
  windowCatalog,
} from './support/fixtures.js';

const windowWith = async (
  handlers: {
    readonly close?: () => { allow: true } | { allow: false; reason: string };
    readonly flush?: () => Promise<void>;
  } = {},
  options: { readonly hooks?: boolean } = {},
) => {
  const bundles: ClientBundle[] = [
    ...(options.hooks === false
      ? [{ id: 'core', activate: () => undefined }]
      : [clientHooksBundle({ registrations: [], defined: [] })]),
    {
      id: 'editor',
      requires: ['hooks/v1@^1.0.0'],
      activate: ({ services }) => {
        if (options.hooks === false) {
          return;
        }

        const registrar = services.use(HooksV1).use(WindowHooksV1);

        if (handlers.close !== undefined) {
          registrar.onCloseHook(handlers.close);
        }

        if (handlers.flush !== undefined) {
          registrar.onFlushHook(handlers.flush);
        }
      },
    },
  ];
  const description = describe();
  const catalog = windowCatalog(bundles, { core: 'core' });
  const desktop = fakeDesktop(description, catalog);
  const activation = await activateClientBundles({
    catalog,
    desktop,
    description,
    importPart: importerOf(bundles),
  });

  return { desktop, windowHooks: activation.windowHooks };
};

void test('a close phase asks onCloseHook and returns its refusal', async () => {
  const { desktop, windowHooks } = await windowWith({
    close: () => ({ allow: false, reason: 'Unsaved changes.' }),
  });

  wireClose({ desktop, windowHooks });

  assert.deepEqual(
    await desktop.requestClose({ phase: 'close', forced: false, deadline: 0 }),
    { allow: false, reason: 'Unsaved changes.' },
  );
});

void test('a forced close is allowed without asking the handlers', async () => {
  let asked = 0;
  const { desktop, windowHooks } = await windowWith({
    close: () => {
      asked += 1;

      return { allow: false, reason: 'Unsaved changes.' };
    },
  });

  wireClose({ desktop, windowHooks });

  assert.deepEqual(
    await desktop.requestClose({ phase: 'close', forced: true, deadline: 0 }),
    { allow: true },
  );
  assert.equal(asked, 0);
});

void test('a window without client hooks allows closing', async () => {
  const { desktop, windowHooks } = await windowWith({}, { hooks: false });

  wireClose({ desktop, windowHooks });

  assert.deepEqual(
    await desktop.requestClose({ phase: 'close', forced: false, deadline: 0 }),
    { allow: true },
  );
});

void test('the flush phase runs onFlushHook before answering allow', async () => {
  const flushed: string[] = [];
  const { desktop, windowHooks } = await windowWith({
    flush: async () => {
      flushed.push('hook');
    },
  });

  wireClose({ desktop, windowHooks });

  assert.deepEqual(
    await desktop.requestClose({
      phase: 'flush',
      forced: false,
      deadline: Date.now() + 5_000,
    }),
    { allow: true },
  );
  assert.deepEqual(flushed, ['hook']);
});
