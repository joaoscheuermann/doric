// The provider page's field slot, `settings.provider.field` (bundle isolation
// 6(a), D14, T6.1): an item of another bundle stands in for one field of one
// provider kind. `settings` draws the item's element where the field stands,
// sets `view` on it (the field's value, the stored credential's name and the
// page's problem with it), and takes its answer from the bubbling, composed
// DOM event `settings-provider-field`: it reads the credentials again, then
// writes the value into the field of the open provider when that provider is
// still of the item's kind. With two items for one field the first by `order`
// is drawn; with none, or with an item whose props are malformed, `settings`
// draws the field itself.
//
// The kind `acme` and the probe bundle are made up: `settings` names no kind.
// The probe defines `probe-field`, which records every `view` set on it, and
// adds its items to the slot as another bundle's client part would.

import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { type RegionItem, RegionsV1, UiV1 } from 'bundle/contracts';

import type {
  ProviderFieldItemProps,
  ProviderFieldView,
  SETTINGS_PROVIDER_FIELD,
} from '../../src/contracts/index.js';
import {
  type HostAnswer,
  openSettingsWindow,
  type ProbeBundle,
  type SettingsWindow,
  settle,
} from './support/window.js';

/** The slot, by its id: the probe names it as another bundle would (D32). */
const slot = 'settings.provider.field' satisfies typeof SETTINGS_PROVIDER_FIELD;

/** The event an item answers the page with. */
const answerEvent = 'settings-provider-field';

/** A made-up kind: a required secret `key`, a plain `project` and an advanced `url`. */
const acme = {
  id: 'acme',
  label: 'Acme',
  description: 'A made-up provider kind.',
  fields: [
    { key: 'key', label: 'Key', kind: 'secret', required: true },
    { key: 'project', label: 'Project', kind: 'text', required: false },
    {
      key: 'url',
      label: 'URL',
      kind: 'url',
      required: false,
      advanced: true,
    },
  ],
  lists: [],
};

/** A second made-up kind with a `key` of its own, keeping its models. */
const other = {
  id: 'other',
  label: 'Other',
  description: 'Another made-up provider kind.',
  fields: [{ key: 'key', label: 'Key', kind: 'secret', required: true }],
  lists: ['models'],
};

/** The credential an `acme` provider names. */
const acmeKey = {
  id: '00000000-0000-4000-8000-0000000000a1',
  kind: 'API_TOKEN',
  name: 'Acme key',
  hasSecret: true,
};

/** The credential an `other` provider names. */
const otherKey = {
  id: '00000000-0000-4000-8000-0000000000b1',
  kind: 'API_TOKEN',
  name: 'Other key',
  hasSecret: true,
};

/** A credential the item stores and answers with, unknown to the first read. */
const freshKey = {
  id: '00000000-0000-4000-8000-0000000000c1',
  kind: 'API_TOKEN',
  name: 'Fresh key',
  hasSecret: true,
};

/** A credential of a kind another bundle stores: the MCP bundle's token. */
const mcpToken = {
  id: '00000000-0000-4000-8000-0000000000dd',
  kind: 'MCP_TOKEN',
  name: 'mcp:server',
  hasSecret: true,
};

/** A saved provider of `kind` named `id` whose `key` is `key`. */
const saved = (id: string, kind: string, key: string) => ({
  id,
  kind,
  configuration: { key },
});

/** The provider the stored configuration executes with: `omega`, of `other`. */
const omega = {
  ...saved('omega', 'other', otherKey.id),
  models: [{ name: 'omega-1' }],
};

/** The stored configuration holding `omega` and `providers`. */
const configurationOf = (providers: readonly unknown[]) => ({
  providers: [omega, ...providers],
  models: { execution: { providerId: 'omega', model: 'omega-1' } },
  execution: { maxTurns: 32 },
});

/** A configuration as `host-config/v1.replace` was sent it. */
interface Sent {
  readonly providers: readonly {
    readonly id: string;
    readonly kind: string;
    readonly configuration: Readonly<Record<string, string>>;
    readonly models?: readonly {
      readonly name: string;
      readonly reasonings?: readonly string[];
    }[];
  }[];
}

/**
 * A host storing every replace, with `acme` first so the add-provider page is
 * its own; `list` answers `secrets/v1.list`, read by the test as it goes.
 */
const acmeHost = (
  input: {
    readonly providers?: readonly unknown[];
    readonly list?: () => unknown;
    readonly kinds?: readonly unknown[];
  } = {},
) => {
  let revision = 1;
  const replaces: Sent[] = [];
  return {
    replaces,
    host: {
      'host-config/v1.current': () => ({
        configuration: configurationOf(input.providers ?? []),
        revision,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      'host-config/v1.replace': (sent: unknown) => {
        revision += 1;
        replaces.push(sent as Sent);
        return {
          status: 'replaced',
          config: {
            configuration: sent,
            revision,
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        };
      },
      'models/v1.kinds': () => input.kinds ?? [acme, other],
      'secrets/v1.list': input.list ?? (() => [acmeKey, otherKey]),
      'tools/v1.catalog': () => [],
    } satisfies Record<string, HostAnswer>,
  };
};

/** What the probe's elements were set, by tag, in order. */
interface Probe {
  readonly bundle: ProbeBundle;
  /** Every `view` set on an element of `tag`, oldest first. */
  views(tag: string): readonly ProviderFieldView[];
}

/** An element of the probe, as the window holds it. */
type ProbeElement = HTMLElement & { view?: ProviderFieldView };

/**
 * A bundle that defines one recording element per tag its `items` name and
 * adds the items to the slot.
 */
const probeOf = (
  items: readonly RegionItem[],
  options: {
    /** Tags whose element throws as it is constructed: `ui.create` fails. */
    readonly failing?: readonly string[];
  } = {},
): Probe => {
  const views = new Map<string, ProviderFieldView[]>();
  const failing = new Set(options.failing ?? []);
  return {
    views: (tag) => views.get(tag) ?? [],
    bundle: {
      requires: ['ui/v1@^1.0.0', 'regions/v1@^1.0.0'],
      activate: ({ services }) => {
        const ui = services.use(UiV1);
        const regions = services.use(RegionsV1);
        const disposables = [
          ...[...new Set(items.map((item) => item.tag))].map((tag) => {
            class ProbeField extends HTMLElement {
              constructor() {
                super();
                if (failing.has(tag))
                  throw new Error(`<${tag}> cannot be created.`);
              }
              #view: ProviderFieldView | undefined;
              get view(): ProviderFieldView | undefined {
                return this.#view;
              }
              set view(next: ProviderFieldView | undefined) {
                this.#view = next;
                if (next === undefined) return;
                views.set(tag, [...(views.get(tag) ?? []), next]);
              }
            }
            return ui.define(tag, ProbeField);
          }),
          ...items.map((item) => regions.add(slot, item)),
        ];
        return () => {
          for (const disposable of disposables) disposable.dispose();
        };
      },
    },
  };
};

/** The probe's item for `acme`'s `key`. */
const acmeItem = {
  id: 'probe',
  tag: 'probe-field',
  props: { kind: 'acme', field: 'key' } satisfies ProviderFieldItemProps,
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const rowOf = (window: SettingsWindow, name: string): HTMLElement => {
  const row = [
    ...window.document.querySelectorAll<HTMLElement>(
      '[data-slot="table-body"] [data-slot="table-row"]',
    ),
  ].find((candidate) => (candidate.textContent ?? '').includes(name));
  assert.ok(row !== undefined, `The providers table has no ${name} row.`);
  return row;
};

/** Opens the window, with `probe` when given, at the Providers section. */
const openWindow = async (
  host: Readonly<Record<string, HostAnswer>>,
  probe?: Probe,
): Promise<SettingsWindow> => {
  opened = await openSettingsWindow({
    host,
    ...(probe === undefined ? {} : { probe: probe.bundle }),
  });
  await settle(20);
  return opened;
};

/** Opens the window and its add-provider page, of the first kind. */
const addProviderPage = async (
  host: Readonly<Record<string, HostAnswer>>,
  probe?: Probe,
): Promise<SettingsWindow> => {
  const window = await openWindow(host, probe);
  const add = window.document.querySelector<HTMLElement>(
    'button[aria-label="Add provider"]',
  );
  assert.ok(add !== null, 'The add-provider control is missing.');
  add.click();
  await settle(20);
  return window;
};

/** Opens the window and the page of the saved provider named `name`. */
const providerPage = async (
  host: Readonly<Record<string, HostAnswer>>,
  name: string,
  probe?: Probe,
): Promise<SettingsWindow> => {
  const window = await openWindow(host, probe);
  rowOf(window, name).click();
  await settle(20);
  return window;
};

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

const nameProvider = async (
  window: SettingsWindow,
  name: string,
): Promise<void> => {
  const input = window.document.getElementById('provider-name');
  assert.ok(input !== null, 'The page has no name field.');
  type(input as HTMLInputElement, name);
  await settle(20);
};

/** The drawn element of `tag`; fails when none or more than one is drawn. */
const drawnOf = (window: SettingsWindow, tag: string): ProbeElement => {
  const drawn = [...window.document.querySelectorAll<ProbeElement>(tag)];
  assert.equal(drawn.length, 1, `<${tag}> is drawn ${drawn.length} times.`);
  return drawn[0] as ProbeElement;
};

/** The item answers the page as its element would: bubbling and composed. */
const answer = async (element: ProbeElement, value: string): Promise<void> => {
  element.dispatchEvent(
    new CustomEvent(answerEvent, {
      bubbles: true,
      composed: true,
      detail: { value },
    }),
  );
  await settle(20);
};

/** The view as set, without the properties it leaves unset. */
const shown = (view: ProviderFieldView | undefined): object =>
  Object.fromEntries(
    Object.entries(view ?? {}).filter(([, value]) => value !== undefined),
  );

const lastView = (probe: Probe, tag = 'probe-field'): ProviderFieldView => {
  const view = probe.views(tag).at(-1);
  assert.ok(view !== undefined, `No view was set on <${tag}>.`);
  return view;
};

const bodyText = (window: SettingsWindow): string =>
  window.document.body.textContent ?? '';

const buttonOf = (
  window: SettingsWindow,
  label: string,
): HTMLButtonElement | undefined =>
  [...window.document.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | undefined;

/** Whether `first` comes before `second` in the document. */
const precedes = (first: Node, second: Node): boolean =>
  (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !==
  0;

test('AC6.1: the add-provider page of a kind with an item draws the item where its field stands, with the view of that field', async () => {
  const probe = probeOf([acmeItem]);
  const window = await addProviderPage(acmeHost().host, probe);

  const element = drawnOf(window, 'probe-field');
  assert.ok(
    window.document.getElementById('provider-key') === null,
    'settings still draws the key the item stands in for.',
  );
  const name = window.document.getElementById('provider-name');
  const project = window.document.getElementById('provider-project');
  assert.ok(name !== null && project !== null, 'The other fields are gone.');
  assert.ok(precedes(name, element), 'The item is drawn above the name.');
  assert.ok(precedes(element, project), 'The item is not where key stands.');

  const view = lastView(probe);
  assert.equal(view.kind, 'acme');
  assert.equal(view.field, 'key');
  assert.equal(view.value ?? '', '');
  assert.equal(view.label, undefined);
  assert.equal(view.problem, undefined);
});

test('AC6.1, O1: a saved provider whose field names a stored credential sets its value and the credential name, and the page has no problem', async () => {
  const probe = probeOf([acmeItem]);
  const window = await providerPage(
    acmeHost({ providers: [saved('alpha', 'acme', acmeKey.id)] }).host,
    'alpha',
    probe,
  );

  drawnOf(window, 'probe-field');
  assert.deepEqual(shown(lastView(probe)), {
    kind: 'acme',
    field: 'key',
    value: acmeKey.id,
    label: 'Acme key',
  });
  assert.doesNotMatch(bodyText(window), /This provider cannot be saved yet/);
});

test('AC6.1, O2: a saved provider whose field names no stored credential sets the problem unknown, and the page draws no alert of its own', async () => {
  const gone = '00000000-0000-4000-8000-0000000000ee';
  const probe = probeOf([acmeItem]);
  const window = await providerPage(
    acmeHost({
      providers: [saved('alpha', 'acme', gone)],
      list: () => [otherKey],
    }).host,
    'alpha',
    probe,
  );

  drawnOf(window, 'probe-field');
  assert.deepEqual(shown(lastView(probe)), {
    kind: 'acme',
    field: 'key',
    value: gone,
    problem: 'unknown',
  });
  assert.doesNotMatch(bodyText(window), /This provider cannot be saved yet/);
});

test('AC6.1, O2: a new provider has no problem until it is named, then an empty field is missing and the page draws no alert of its own', async () => {
  const probe = probeOf([acmeItem]);
  const window = await addProviderPage(acmeHost().host, probe);

  // Unnamed: the page's own issue is the id, and the item has no problem.
  assert.equal(lastView(probe).problem, undefined);
  assert.match(bodyText(window), /This provider cannot be saved yet/);
  assert.match(bodyText(window), /Enter an id between 1 and/);

  await nameProvider(window, 'alpha');

  assert.equal(lastView(probe).problem, 'missing');
  assert.doesNotMatch(bodyText(window), /This provider cannot be saved yet/);
});

test("AC6.1: the item's answer reads the credentials again, then fills the field, which the next save carries and the next view shows", async () => {
  let stored: readonly unknown[] = [acmeKey, otherKey];
  const { replaces, host } = acmeHost({ list: () => stored });
  const probe = probeOf([acmeItem]);
  const window = await addProviderPage(host, probe);
  await nameProvider(window, 'alpha');
  const reads = window.received('secrets/v1.list').length;

  // The item stored a credential the page has not read yet.
  stored = [acmeKey, otherKey, freshKey];
  await answer(drawnOf(window, 'probe-field'), freshKey.id);
  await settle(700);

  assert.ok(
    window.received('secrets/v1.list').length > reads,
    'The answer did not read the credentials again.',
  );
  const provider = replaces
    .at(-1)
    ?.providers.find((entry) => entry.id === 'alpha');
  assert.equal(provider?.kind, 'acme');
  assert.equal(provider?.configuration.key, freshKey.id);
  assert.deepEqual(shown(lastView(probe)), {
    kind: 'acme',
    field: 'key',
    value: freshKey.id,
    label: 'Fresh key',
  });
});

test('AC6.1: an answer that lands after the page moved to a provider of another kind writes nothing', async () => {
  const held: (() => void)[] = [];
  let hold = false;
  const credentials = [acmeKey, otherKey, freshKey];
  const { replaces, host } = acmeHost({
    providers: [saved('alpha', 'acme', acmeKey.id)],
    // Once held, every read answers only when the test releases them.
    list: () =>
      hold
        ? new Promise((done) => {
            held.push(() => done(credentials));
          })
        : credentials,
  });
  const probe = probeOf([acmeItem]);
  const window = await providerPage(host, 'alpha', probe);

  hold = true;
  await answer(drawnOf(window, 'probe-field'), freshKey.id);
  const back = window.document.querySelector<HTMLElement>(
    'button[aria-label="Back"]',
  );
  assert.ok(back !== null, 'The provider page offers no way back.');
  back.click();
  await settle(20);
  rowOf(window, 'omega').click();
  await settle(20);
  assert.equal(
    (window.document.getElementById('provider-name') as HTMLInputElement | null)
      ?.value,
    'omega',
  );
  assert.ok(held.length > 0, 'The answer did not read the credentials.');
  for (const release of held) release();
  await settle(700);

  assert.deepEqual(replaces, [], 'An answer for acme was written.');
});

test("AC6.1: a credential of another kind beside the named one makes no problem, and the page's edits still reach the host", async () => {
  const { replaces, host } = acmeHost({
    providers: [saved('alpha', 'acme', acmeKey.id)],
    list: () => [acmeKey, otherKey, mcpToken],
  });
  const probe = probeOf([acmeItem]);
  const window = await providerPage(host, 'alpha', probe);

  assert.deepEqual(shown(lastView(probe)), {
    kind: 'acme',
    field: 'key',
    value: acmeKey.id,
    label: 'Acme key',
  });
  assert.doesNotMatch(bodyText(window), /This provider cannot be saved yet/);

  type(
    window.document.getElementById('provider-project') as HTMLInputElement,
    'apollo',
  );
  await settle(700);
  const provider = replaces
    .at(-1)
    ?.providers.find((entry) => entry.id === 'alpha');
  assert.deepEqual(provider?.configuration, {
    key: acmeKey.id,
    project: 'apollo',
  });
});

test("AC6.1: an item for another kind is not drawn on this kind's page, which draws the field itself", async () => {
  const window = await addProviderPage(
    acmeHost().host,
    probeOf([
      {
        id: 'probe',
        tag: 'probe-field',
        props: { kind: 'other', field: 'key' } satisfies ProviderFieldItemProps,
      },
    ]),
  );

  assert.equal(window.document.querySelectorAll('probe-field').length, 0);
  assert.ok(
    window.document.getElementById('provider-key') !== null,
    "settings does not draw acme's key.",
  );
});

test('AC6.1: a composition without an item draws every field of the kind itself', async () => {
  const window = await addProviderPage(acmeHost().host);

  assert.ok(
    window.document.getElementById('provider-key') !== null,
    "settings does not draw acme's key.",
  );
  assert.ok(window.document.getElementById('provider-project') !== null);
});

test('AC6.1: of two items for one field, the first by order is drawn and the other is not', async () => {
  const probe = probeOf([
    {
      id: 'late',
      tag: 'probe-late',
      order: 20,
      props: { kind: 'acme', field: 'key' } satisfies ProviderFieldItemProps,
    },
    {
      id: 'early',
      tag: 'probe-early',
      order: 10,
      props: { kind: 'acme', field: 'key' } satisfies ProviderFieldItemProps,
    },
  ]);
  const window = await addProviderPage(acmeHost().host, probe);

  drawnOf(window, 'probe-early');
  assert.equal(window.document.querySelectorAll('probe-late').length, 0);
  assert.deepEqual(probe.views('probe-late'), []);
  assert.ok(window.document.getElementById('provider-key') === null);
});

test('AC6.1: a kind that keeps models and efforts offers both beside the item', async () => {
  const probe = probeOf([acmeItem]);
  const window = await addProviderPage(
    acmeHost({
      kinds: [{ ...acme, lists: ['models', 'reasonings'] }, other],
    }).host,
    probe,
  );

  drawnOf(window, 'probe-field');
  buttonOf(window, 'Add model')?.click();
  await settle(20);

  const efforts = [
    ...window.document.querySelectorAll('[aria-label$=" for model 1"]'),
  ];
  assert.ok(efforts.length > 0, 'An acme model offers no efforts.');
});

test("AC6.1: a kind whose models are its catalog reads the catalog once after the item's answer, never before", async () => {
  const listed = {
    ...acme,
    lists: ['models', 'reasonings'],
    modelsFromCatalog: true,
  };
  const catalogReads: unknown[] = [];
  const { replaces, host } = acmeHost({ kinds: [listed, other] });
  const probe = probeOf([acmeItem]);
  const window = await addProviderPage(
    {
      ...host,
      'models/v1.kind': () => listed,
      'models/v1.catalog': (input: unknown) => {
        catalogReads.push(input);
        return {
          status: 'read',
          models: [
            {
              id: 'acme-large',
              reasonings: ['low', 'medium', 'high'],
              parameters: [],
              defaultEffort: 'medium',
              mandatory: false,
            },
            {
              id: 'acme-small',
              reasonings: [],
              parameters: [],
              mandatory: false,
            },
          ],
        };
      },
    },
    probe,
  );

  assert.ok(
    buttonOf(window, 'Add model') === undefined,
    'A catalog-listed kind asks for a model by hand.',
  );
  assert.equal(catalogReads.length, 0);

  await nameProvider(window, 'alpha');
  await answer(drawnOf(window, 'probe-field'), acmeKey.id);
  await settle(60);

  assert.equal(catalogReads.length, 1);
  const text = bodyText(window);
  assert.match(text, /acme-large/);
  assert.match(text, /acme-small/);

  await settle(700);
  const provider = replaces
    .at(-1)
    ?.providers.find((entry) => entry.id === 'alpha');
  assert.deepEqual(
    provider?.models?.map(({ name, reasonings }) => ({ name, reasonings })),
    [
      { name: 'acme-large', reasonings: ['low', 'medium', 'high'] },
      { name: 'acme-small', reasonings: [] },
    ],
  );
});

test('O7: an item whose props are malformed is not drawn, and the page draws the field itself', async () => {
  const window = await addProviderPage(
    acmeHost().host,
    probeOf([
      { id: 'probe', tag: 'probe-field', props: { kind: 'acme' } },
      {
        id: 'blank',
        tag: 'probe-blank',
        props: { kind: 'acme', field: '' },
      },
    ]),
  );

  assert.equal(window.document.querySelectorAll('probe-field').length, 0);
  assert.equal(window.document.querySelectorAll('probe-blank').length, 0);
  assert.ok(
    window.document.getElementById('provider-key') !== null,
    "settings does not draw acme's key.",
  );
});

/** The probe's item for `acme`'s optional `project`. */
const projectItem = {
  id: 'probe-project',
  tag: 'probe-project',
  props: { kind: 'acme', field: 'project' } satisfies ProviderFieldItemProps,
};

test("OD48: an optional empty field's item gets no problem while the draft has an issue, and the page keeps its alert", async () => {
  const probe = probeOf([projectItem]);
  const window = await addProviderPage(acmeHost().host, probe);
  // Named, with the required key still empty: the draft has an issue.
  await nameProvider(window, 'alpha');

  drawnOf(window, 'probe-project');
  assert.ok(
    window.document.getElementById('provider-key') !== null,
    "settings does not draw acme's key.",
  );
  assert.deepEqual(shown(lastView(probe, 'probe-project')), {
    kind: 'acme',
    field: 'project',
  });
  assert.match(bodyText(window), /This provider cannot be saved yet/);
});

test('OD48: of two empty fields with items, the required one is missing and the optional one has no problem', async () => {
  const probe = probeOf([acmeItem, projectItem]);
  const window = await addProviderPage(acmeHost().host, probe);
  await nameProvider(window, 'alpha');

  assert.equal(lastView(probe).problem, 'missing');
  assert.equal(lastView(probe, 'probe-project').problem, undefined);
  // The required field's item shows the problem in the page's stead (O2).
  assert.doesNotMatch(bodyText(window), /This provider cannot be saved yet/);
});

test("OD48: an item whose element cannot be created leaves its field to settings, which sets no problem from it and keeps the page's alert", async () => {
  const brokenItem = {
    id: 'probe-broken',
    tag: 'probe-broken',
    props: { kind: 'acme', field: 'key' } satisfies ProviderFieldItemProps,
  };
  const probe = probeOf([brokenItem], { failing: ['probe-broken'] });
  const window = await addProviderPage(acmeHost().host, probe);
  // Named, with the required key empty: an item drawn would be missing.
  await nameProvider(window, 'alpha');

  assert.equal(window.document.querySelectorAll('probe-broken').length, 0);
  assert.ok(
    window.document.getElementById('provider-key') !== null,
    "settings does not draw acme's key in the failed item's place.",
  );
  assert.match(bodyText(window), /This provider cannot be saved yet/);
});

// AC6.2: settings names no kind, and the Claude sign-in is the sign-in
// bundle's. Its id is built from parts, so no file here names it (AC6.2).

/** The id of the bundle that owns the Claude sign-in. */
const signInBundle = ['claude', 'login'].join('-');

const settingsRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

/** Every file under `dir`. */
const files = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
};

test("AC6.2: no source of settings names the claude kind, imports the sign-in bundle's contracts or keeps sign_in_failed", async () => {
  const naming: string[] = [];
  for (const file of await files(join(settingsRoot, 'src'))) {
    const text = await readFile(file, 'utf8');
    if (
      text.includes("'claude'") ||
      text.includes(`${signInBundle}/contracts`) ||
      text.includes('sign_in_failed')
    )
      naming.push(file.slice(settingsRoot.length + 1));
  }

  assert.deepEqual(naming, []);
});

test('AC6.2: the settings manifest is 1.12.2 and takes no claude.login/v1, and its package does not list the sign-in bundle', async () => {
  const manifest = JSON.parse(
    await readFile(join(settingsRoot, 'manifest.json'), 'utf8'),
  ) as { readonly version: string; readonly optional?: readonly string[] };
  const pkg = JSON.parse(
    await readFile(join(settingsRoot, 'package.json'), 'utf8'),
  ) as {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly devDependencies?: Readonly<Record<string, string>>;
  };

  assert.equal(manifest.version, '1.12.2');
  assert.ok(
    !(manifest.optional ?? []).includes('claude.login/v1'),
    `optional ${(manifest.optional ?? []).join(', ')}`,
  );
  assert.equal(pkg.dependencies?.[signInBundle], undefined);
  assert.equal(pkg.devDependencies?.[signInBundle], undefined);
});
