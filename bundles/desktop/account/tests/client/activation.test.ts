// The account's activation (bundle isolation 4(b), spec §7): it defines
// `<account-status>` and adds it to the shell's `shell.window.actions` slot,
// the frame's place for window actions, so the composed window shows the
// "Account" button in the page form and in the conversation form (AC4.2).
// Its cleanup takes both back.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { type Disposable, type Services, UiV1 } from 'bundle/contracts';

import { renderAccount } from './support/render-account.js';

test('the activation defines account-status and adds it to shell.window.actions, and its cleanup takes both back', async () => {
  // Mounting once installs happy-dom's window as the globals.
  (await renderAccount()).cleanup();
  const { createFakeHost } = await import('../../stories/support/fake-host.js');
  const { activate } = await import('../../src/client/index.js');
  const host = createFakeHost();
  const inner = host.services;
  const ui = inner.use(UiV1);

  /** The tags defined through `ui/v1` and not disposed yet. */
  const defined = new Set<string>();
  const recorded: Record<string, unknown> = {
    [UiV1.id]: {
      ...ui,
      define: (
        tag: string,
        element: Parameters<typeof ui.define>[1],
      ): Disposable => {
        defined.add(tag);
        const registration = ui.define(tag, element);
        return {
          dispose: () => {
            defined.delete(tag);
            registration.dispose();
          },
        };
      },
    },
  };
  const services = {
    ...inner,
    use: (contract: { readonly id: string }) =>
      recorded[contract.id] ?? inner.use(contract as never),
  } as unknown as Services;

  const cleanup = activate({ services });

  assert.deepEqual(
    host
      .regionItems('shell.window.actions')
      .map(({ id, tag }) => ({ id, tag })),
    [{ id: 'account', tag: 'account-status' }],
  );
  assert.ok(
    defined.has('account-status'),
    `The activation did not define account-status: ${[...defined].join(', ')}`,
  );

  await cleanup();

  assert.deepEqual(host.regionItems('shell.window.actions'), []);
  assert.ok(
    !defined.has('account-status'),
    'The cleanup did not dispose the definition of account-status.',
  );
});
