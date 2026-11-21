// The client part's activation (bundle isolation 6(a), spec `:1270`): it
// defines `claude-login-field` through `ui/v1` and adds the item that stands in
// for the `claude` kind's `token` field to `settings.provider.field` through
// `regions/v1`; its cleanup takes the item away again.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ClientContext, RegionItem } from 'bundle/contracts';

import { installWindow } from './support/render.js';
import { fakeServices } from './support/services.js';

test("activate defines claude-login-field and adds the claude token's item to settings.provider.field, and its cleanup removes the item", async () => {
  installWindow();
  const defined: { readonly tag: string; readonly element: unknown }[] = [];
  const items: { readonly region: string; readonly item: RegionItem }[] = [];
  const { services } = fakeServices({
    'ui/v1': {
      define: (tag: string, element: unknown) => {
        defined.push({ tag, element });
        return { dispose: () => undefined };
      },
      create: () => document.createElement('div'),
      dispose: () => undefined,
    },
    'regions/v1': {
      add: (region: string, item: RegionItem) => {
        const entry = { region, item };
        items.push(entry);
        return {
          dispose: () => {
            items.splice(items.indexOf(entry), 1);
          },
        };
      },
      items: () => [],
      subscribe: () => ({ dispose: () => undefined }),
    },
  });
  const { activate } = await import('../../src/client/index.js');

  const cleanup = activate({ services } as unknown as ClientContext);

  assert.deepEqual(
    defined.map(({ tag }) => tag),
    ['claude-login-field'],
  );
  assert.equal(typeof defined[0]?.element, 'function');
  assert.deepEqual(items, [
    {
      region: 'settings.provider.field',
      item: {
        id: 'claude-login',
        tag: 'claude-login-field',
        props: { kind: 'claude', field: 'token' },
      },
    },
  ]);

  cleanup();

  assert.deepEqual(items, [], 'The cleanup leaves the item in the slot.');
});
