import assert from 'node:assert/strict';
import test from 'node:test';

import { DoricAppearanceV1 } from 'bundle/contracts';

import {
  activateClientBundles,
  type BridgeCallEnvelope,
} from '../../src/client/index.js';
import {
  asDocument,
  type ClientBundle,
  describe,
  fakeDesktop,
  fakeDocument,
  importerOf,
  settle,
  windowCatalog,
} from './support/fixtures.js';

void test('doric.appearance/v1 reaches main through doric.shell/v1 for a bundle that does not require it (T-4.1.7)', async () => {
  let read: { readonly theme: string } | undefined;
  const bundles: readonly ClientBundle[] = [
    {
      id: 'settings',
      // No `doric.appearance/v1` here: platform contracts need no entry.
      requires: [],
      activate: async ({ services }) => {
        const appearance = services.use(DoricAppearanceV1);

        read = await appearance.get();
        await appearance.set({ theme: 'light' });
      },
    },
  ];
  const description = describe();
  const catalog = windowCatalog(bundles, { core: 'settings' });
  const base = fakeDesktop(description, catalog);
  const shell: { method: string; input: unknown }[] = [];
  const desktop = {
    ...base,
    call: async (envelope: BridgeCallEnvelope) => {
      if (
        envelope.contract === 'doric.shell/v1' &&
        envelope.method.startsWith('appearance')
      ) {
        shell.push({ method: envelope.method, input: envelope.input });

        return {
          ok: true as const,
          output:
            envelope.method === 'appearanceGet'
              ? { theme: 'system' }
              : undefined,
        };
      }

      return base.call(envelope);
    },
  };

  await activateClientBundles({
    catalog,
    desktop,
    description,
    document: asDocument(fakeDocument()),
    importPart: importerOf(bundles),
  });
  await settle();

  assert.deepEqual(read, { theme: 'system' });
  assert.deepEqual(shell, [
    { method: 'appearanceGet', input: {} },
    { method: 'appearanceSet', input: { theme: 'light' } },
  ]);
});
