// The Claude sign-in as the settings window meets it: the provider page of
// the `claude` kind offers the sign-in no other kind draws, a sign-in opens
// the host's authorization page in the system browser and waits on it until
// cancelled, and a finished one settles the credential into the provider's
// token field and announces itself.

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

/** The authorization page the host's `start` answers. */
const authorizeUrl = 'https://claude.com/cai/oauth/authorize?state=s';

/**
 * A host answering the sign-in's `finish` with `finish` and storing every
 * replace, with the `claude` kind first so the add-provider page is its own.
 */
const claudeHost = (finish: HostAnswer) => {
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
      'claude.login/v1.start': () => ({ url: authorizeUrl }),
      'claude.login/v1.finish': finish,
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
  index = 0,
): string | undefined =>
  [
    ...([...window.document.querySelectorAll('[data-slot="field"]')]
      .find(
        (field) =>
          field
            .querySelector('[data-slot="field-label"]')
            ?.textContent?.trim() === label,
      )
      ?.querySelectorAll('[data-slot="field-description"]') ?? []),
  ][index]?.textContent ?? undefined;

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
  absent: readonly string[] = [],
): Promise<SettingsWindow> => {
  const opened = await openSettingsWindow({ host, absent });
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
  assert.match(description, /browser/);
  assert.match(description, /stored|storage/);
  // The sign-in is how the token is filled: no credential is picked by hand,
  // and a named provider waits on the sign-in alone.
  assert.ok(
    opened.document.getElementById('provider-token') === null,
    'The claude page still asks for a token by hand.',
  );
  type(
    opened.document.getElementById('provider-name') as HTMLInputElement,
    'Claude',
  );
  await settle(20);
  assert.match(
    opened.document.body.textContent ?? '',
    /Sign in with Claude to finish this provider\./,
  );

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
  // The host's authorization page went to the system browser, and stays
  // on the row for a browser that did not come up.
  assert.deepEqual(
    opened.received('doric.shell/v1.openExternal').map((call) => call.input),
    [{ url: authorizeUrl }],
  );
  assert.match(
    fieldDescriptionOf(opened, 'Claude login', 1) ?? '',
    /If the browser did not open, visit https:\/\/claude\.com\//,
  );
  assert.equal(opened.received('claude.login/v1.finish').length, 1);

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
  const finish = opened.received('claude.login/v1.finish')[0]?.id;
  assert.ok(
    finish !== undefined && opened.canceled().includes(finish),
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
  // The row names the credential the sign-in stored and offers a new one.
  assert.match(
    fieldDescriptionOf(opened, 'Claude login') ?? '',
    /this provider uses the 'Claude' credential/,
  );
  assert.ok(
    buttonOf(opened, 'Sign in again') !== undefined,
    'A signed-in provider offers no fresh sign-in.',
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

test('a sign-in the authorization refuses announces its own message', async () => {
  const { host } = claudeHost(() => {
    throw new ContractError(
      'claude_login_failed',
      'The Claude sign-in failed: access_denied',
    );
  });
  opened = await addProviderPage(host);

  buttonOf(opened, 'Sign in with Claude')?.click();
  await settle(30);

  assert.match(toastsOf(opened), /The Claude sign-in failed: access_denied/);
  const again = buttonOf(opened, 'Sign in with Claude');
  assert.ok(again !== undefined, 'A refused sign-in stays busy.');
  assert.equal(again.disabled, false);
});

test('a composition without the Claude sign-in still configures the claude kind, drawing no sign-in', async () => {
  opened = await addProviderPage(claudeHost(() => signedIn).host, [
    'claude.login/v1',
  ]);

  assert.ok(
    buttonOf(opened, 'Sign in with Claude') === undefined,
    'The sign-in shows with no provider to answer it.',
  );
  assert.equal(fieldDescriptionOf(opened, 'Claude login'), undefined);
  assert.ok(
    opened.document.getElementById('provider-token') !== null,
    'The claude kind lost its token field.',
  );
});

test('a claude kind that keeps models and efforts offers both beside the sign-in', async () => {
  const { host } = claudeHost(() => signedIn);
  opened = await addProviderPage({
    ...host,
    'models/v1.kinds': () => [
      { ...claude, lists: ['models', 'reasonings'] },
      openrouter,
    ],
  });

  assert.ok(
    buttonOf(opened, 'Sign in with Claude') !== undefined,
    'The sign-in is missing.',
  );
  buttonOf(opened, 'Add model')?.click();
  await settle(20);

  const efforts = [
    ...opened.document.querySelectorAll('[aria-label$=" for model 1"]'),
  ];
  assert.ok(efforts.length > 0, 'A claude model offers no efforts.');
});

test('a claude kind whose models are its catalog fills them from the catalog once signed in, never by hand', async () => {
  const listed = {
    ...claude,
    lists: ['models', 'reasonings'],
    modelsFromCatalog: true,
  };
  const catalogReads: unknown[] = [];
  const { replaces, host } = claudeHost(() => signedIn);
  opened = await addProviderPage({
    ...host,
    'models/v1.kinds': () => [listed, openrouter],
    'models/v1.kind': () => listed,
    'models/v1.catalog': (input: unknown) => {
      catalogReads.push(input);
      return {
        status: 'read',
        models: [
          {
            id: 'claude-opus-5-5',
            name: 'Claude Opus 5.5',
            reasonings: ['low', 'medium', 'high'],
            parameters: [],
            defaultEffort: 'medium',
            mandatory: false,
          },
          {
            id: 'claude-haiku-4-5',
            reasonings: [],
            parameters: [],
            mandatory: false,
          },
        ],
      };
    },
  });

  // Before the sign-in there is nothing to read and nothing to add.
  assert.ok(
    buttonOf(opened, 'Add model') === undefined,
    'A catalog-listed kind asks for a model by hand.',
  );
  assert.match(
    fieldDescriptionOf(opened, 'Models') ?? '',
    /appear here once it is signed in/,
  );
  assert.equal(catalogReads.length, 0);

  type(
    opened.document.getElementById('provider-name') as HTMLInputElement,
    'Claude',
  );
  buttonOf(opened, 'Sign in with Claude')?.click();
  await settle(60);

  // The sign-in's credential reads the catalog, and the list shows its models.
  assert.equal(catalogReads.length, 1);
  const text = opened.document.body.textContent ?? '';
  assert.match(text, /claude-opus-5-5/);
  assert.match(text, /Medium \(default\)/);
  assert.match(text, /claude-haiku-4-5/);

  // The save carries the catalog's models, so the execution section offers them.
  await settle(700);
  const sent = replaces.at(-1) as
    | {
        readonly providers: readonly {
          readonly kind: string;
          readonly models?: readonly {
            readonly name: string;
            readonly reasonings?: readonly string[];
          }[];
        }[];
      }
    | undefined;
  const provider = sent?.providers.find((entry) => entry.kind === 'claude');
  assert.deepEqual(
    provider?.models?.map(({ name, reasonings }) => ({ name, reasonings })),
    [
      { name: 'claude-opus-5-5', reasonings: ['low', 'medium', 'high'] },
      { name: 'claude-haiku-4-5', reasonings: [] },
    ],
  );
});
