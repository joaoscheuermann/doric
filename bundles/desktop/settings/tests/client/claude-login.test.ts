// The Claude sign-in as the settings window meets it: the provider page of
// the `claude` kind offers the sign-in no other kind draws, a running sign-in
// waits on the browser until cancelled, and a finished one settles the
// credential into the provider's token field and announces itself.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { ContractError } from 'bundle/contracts';

import {
  type HostAnswer,
  openSettingsWindow,
  type SettingsWindow,
  settle,
} from './support/window.js';

/** The stored credential the window's OpenRouter provider names. */
const openrouterToken = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'OpenRouter',
  hasSecret: true,
};

/** The credential a sign-in answers: a Claude token, stored. */
const signedIn = {
  id: '00000000-0000-4000-8000-0000000000cc',
  kind: 'API_TOKEN',
  name: 'Claude',
  hasSecret: true,
};

/** The `claude` kind: an endpoint and the token a sign-in fills. */
const claude = {
  id: 'claude',
  label: 'Claude',
  description: 'Anthropic Messages through a Claude Code subscription login.',
  fields: [
    { key: 'endpoint', label: 'Endpoint', kind: 'url', required: false },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
  ],
  lists: [],
};

/** The `openrouter` kind, for a kind that draws no sign-in. */
const openrouter = {
  id: 'openrouter',
  label: 'OpenRouter',
  description: 'Hosted models.',
  fields: [
    { key: 'endpoint', label: 'Endpoint', kind: 'url', required: true },
    { key: 'token', label: 'Token', kind: 'secret', required: true },
  ],
  lists: ['models', 'reasonings'],
};

const configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: {
        endpoint: 'https://openrouter.ai/api/v1',
        token: openrouterToken.id,
      },
      models: [{ name: 'deepseek/v4', reasonings: [] }],
    },
  ],
  models: { execution: { providerId: 'openrouter', model: 'deepseek/v4' } },
  execution: { maxTurns: 32 },
};

/**
 * A host answering the sign-in with `login` and storing every replace, with
 * the `claude` kind first so the add-provider page is its own.
 */
const claudeHost = (login: HostAnswer) => {
  let revision = 1;
  const replaces: unknown[] = [];

  return {
    replaces,
    host: {
      'host-config/v1.current': () => ({
        configuration,
        revision,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'host-config/v1.replace': (input: unknown) => {
        revision += 1;
        replaces.push(input);
        return {
          status: 'replaced',
          config: {
            configuration: input,
            revision,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        };
      },
      'models/v1.kinds': () => [claude, openrouter],
      'secrets/v1.list': () => [openrouterToken],
      'tools/v1.catalog': () => [],
      'claude.login/v1.login': login,
    } satisfies Record<string, HostAnswer>,
  };
};

/** A host with the `openrouter` kind alone, drawing no sign-in. */
const openrouterOnlyHost = () => {
  const { host } = claudeHost(() => signedIn);
  return {
    ...host,
    'models/v1.kinds': () => [openrouter],
  } satisfies Record<string, HostAnswer>;
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const buttonOf = (
  window: SettingsWindow,
  label: string,
): HTMLButtonElement | undefined =>
  [...window.document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

const fieldDescriptionOf = (
  window: SettingsWindow,
  label: string,
): string | undefined =>
  [...window.document.querySelectorAll('[data-slot="field"]')]
    .find(
      (field) =>
        field
          .querySelector('[data-slot="field-label"]')
          ?.textContent?.trim() === label,
    )
    ?.querySelector('[data-slot="field-description"]')?.textContent ??
  undefined;

/** The text of every toast the window carries, one line each. */
const toastsOf = (window: SettingsWindow): string =>
  [...window.document.querySelectorAll('[data-sonner-toast]')]
    .map((toast) => toast.textContent ?? '')
    .join('\n');

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

/** Opens the window and its add-provider page, where the sign-in lives. */
const addProviderPage = async (
  host: Readonly<Record<string, HostAnswer>>,
): Promise<SettingsWindow> => {
  const opened = await openSettingsWindow({ host });
  await settle(20);
  const add = opened.document.querySelector(
    'button[aria-label="Add provider"]',
  ) as HTMLElement | null;
  assert.ok(add !== null, 'The add-provider control is missing.');
  add.click();
  await settle(20);
  return opened;
};

test('the claude provider page offers the sign-in its own kind draws', async () => {
  opened = await addProviderPage(claudeHost(() => signedIn).host);

  const signIn = buttonOf(opened, 'Sign in with Claude');
  assert.ok(signIn !== undefined, 'The sign-in button is missing.');
  assert.equal(signIn.disabled, false);
  // Asserted as a strict `undefined` check: a failed lookup answers a
  // happy-dom element, which a deep-equal would try to serialize whole.
  assert.ok(
    buttonOf(opened, 'Cancel') === undefined,
    'An idle sign-in offers a cancel.',
  );

  const description = fieldDescriptionOf(opened, 'Claude login');
  assert.ok(description !== undefined, 'The sign-in has no description.');
  assert.match(description, /reuse/);
  assert.match(description, /stored|storage/);

  // A kind that is not the claude one draws none of it.
  await opened.close();
  opened = await addProviderPage(openrouterOnlyHost());
  assert.ok(
    buttonOf(opened, 'Sign in with Claude') === undefined,
    'A kind that draws no sign-in still shows one.',
  );
  assert.equal(fieldDescriptionOf(opened, 'Claude login'), undefined);
});

test('a running sign-in waits on the browser until it is cancelled', async () => {
  opened = await addProviderPage(
    claudeHost(() => new Promise(() => undefined)).host,
  );

  buttonOf(opened, 'Sign in with Claude')?.click();
  await settle();

  const waiting = buttonOf(opened, 'Waiting for the browser…');
  assert.ok(waiting !== undefined, 'The busy sign-in shows no waiting label.');
  assert.equal(waiting.disabled, true);
  const cancel = buttonOf(opened, 'Cancel');
  assert.ok(cancel !== undefined, 'A running sign-in offers no cancel.');
  assert.equal(opened.received('claude.login/v1.login').length, 1);

  cancel.click();
  await settle();

  assert.ok(
    buttonOf(opened, 'Cancel') === undefined,
    'A cancelled sign-in keeps its cancel.',
  );
  const again = buttonOf(opened, 'Sign in with Claude');
  assert.ok(again !== undefined, 'A cancelled sign-in stays busy.');
  assert.equal(again.disabled, false);

  // The cancelled call's signal crossed the bridge as its cancellation.
  const login = opened.received('claude.login/v1.login')[0]?.id;
  assert.ok(
    login !== undefined && opened.canceled().includes(login),
    'Cancelling did not abort the sign-in call.',
  );
});

test('a finished sign-in settles the credential into the token field', async () => {
  const { replaces, host } = claudeHost(() => signedIn);
  opened = await addProviderPage(host);

  type(
    opened.document.getElementById('provider-name') as HTMLInputElement,
    'Claude',
  );
  buttonOf(opened, 'Sign in with Claude')?.click();
  await settle(30);

  assert.match(toastsOf(opened), /Claude is signed in\./);
  const trigger = opened.document.getElementById('provider-token');
  const chosen = trigger?.textContent?.trim();
  // The platform's Select appends its own chevron to the trigger's text,
  // so what the auto-select proves is the answered credential's name
  // leading it, not the trigger's whole text.
  assert.ok(
    chosen?.startsWith('Claude'),
    'The token trigger does not name the signed-in credential.',
  );

  // The autosave carries the provider draft the sign-in completed.
  await settle(700);
  const sent = replaces.at(-1) as
    | {
        readonly providers: readonly {
          readonly kind: string;
          readonly configuration: Readonly<Record<string, string>>;
        }[];
      }
    | undefined;
  const provider = sent?.providers.find((entry) => entry.kind === 'claude');
  assert.equal(provider?.configuration.token, signedIn.id);
});

test('a sign-in the host refuses as busy announces its own message', async () => {
  const { host } = claudeHost(() => {
    throw new ContractError(
      'claude_login_busy',
      'A Claude sign-in is already in progress.',
    );
  });
  opened = await addProviderPage(host);

  buttonOf(opened, 'Sign in with Claude')?.click();
  await settle(30);

  assert.match(toastsOf(opened), /A Claude sign-in is already in progress\./);
  const again = buttonOf(opened, 'Sign in with Claude');
  assert.ok(again !== undefined, 'A refused sign-in stays busy.');
  assert.equal(again.disabled, false);
});
