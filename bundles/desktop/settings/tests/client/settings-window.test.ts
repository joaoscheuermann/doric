// The settings window as the user meets it: opened at `/settings`, the nav
// of its own six sections (Versioning is the git bundle's, WP-10N; Appearance
// shows while the app answers `doric.appearance/v1`, as this window's app
// does), each section a route, the search, and the save the window's close
// waits for.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { NavigationV1, RegionsV1, ref, UiV1 } from 'bundle/contracts';

import {
  openSettingsWindow,
  type SettingsWindow,
  settle,
} from './support/window.js';

const token = '00000000-0000-4000-8000-000000000001';

const configuration = {
  providers: [
    {
      id: 'openrouter',
      kind: 'openrouter',
      configuration: { endpoint: 'https://openrouter.ai/api/v1', token },
      models: [{ name: 'deepseek/v4', reasonings: [] }],
    },
  ],
  models: { execution: { providerId: 'openrouter', model: 'deepseek/v4' } },
  execution: { maxTurns: 32 },
};

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

/** A host with one stored configuration; a replace stores what it gets. */
const host = (initial: unknown = configuration) => {
  let revision = 1;
  let stored: unknown = initial;

  return {
    'host-config/v1.current': () => ({
      configuration: stored,
      revision,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }),
    'host-config/v1.replace': (input: unknown) => {
      revision += 1;
      stored = input;
      return {
        status: 'replaced',
        config: {
          configuration: input,
          revision,
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
      };
    },
    'models/v1.kinds': () => [openrouter],
    'secrets/v1.list': () => [],
    'tools/v1.catalog': () => [],
  };
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const heading = (window: SettingsWindow): string | undefined =>
  window.document.querySelector('h1')?.textContent ?? undefined;

const navRows = (window: SettingsWindow): string[] =>
  [...window.document.querySelectorAll('[data-sidebar="menu-button"]')].map(
    (row) => row.textContent ?? '',
  );

const activeRow = (window: SettingsWindow): string | undefined =>
  window.document.querySelector('[data-sidebar="menu-button"][data-active]')
    ?.textContent ?? undefined;

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

const field = (window: SettingsWindow, id: string): HTMLInputElement =>
  window.document.getElementById(id) as HTMLInputElement;

/** A mouse press as a pointer delivers it: down, up, then the click. */
const press = (element: HTMLElement): void => {
  for (const name of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    element.dispatchEvent(
      new window.PointerEvent(name, { bubbles: true, pointerType: 'mouse' }),
    );
  }
  element.click();
};

/** Opens a combobox, types into it and clicks the option named `label`. */
const choose = async (
  window: SettingsWindow,
  input: HTMLInputElement,
  query: string,
  label: string,
): Promise<void> => {
  press(input);
  await settle();
  type(input, query);
  await settle();
  const option = [
    ...window.document.querySelectorAll<HTMLElement>('[role="option"]'),
  ].find((candidate) => candidate.textContent?.trim() === label);
  assert.ok(option, `no option ${label} for "${query}"`);
  option.click();
  await settle();
};

/** The close phases the window's close waits on, which flush the autosave. */
const flush = async (window: SettingsWindow): Promise<void> => {
  await window.requestClose({ phase: 'close', forced: false, deadline: 0 });
  await window.requestClose({
    phase: 'flush',
    forced: false,
    deadline: Date.now() + 1_500,
  });
};

/** The profile of the last configuration the window sent the host. */
const savedProfile = (window: SettingsWindow): unknown =>
  (
    window.received('host-config/v1.replace').at(-1)?.input as
      | { readonly profile?: unknown }
      | undefined
  )?.profile;

test('a window opened at /settings shows the Providers section and names itself', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  assert.equal(opened.window.location.pathname, '/settings/providers');
  assert.equal(opened.document.title, 'Doric Settings');
  assert.equal(heading(opened), 'Providers');
  assert.deepEqual(navRows(opened), [
    'Profile',
    'Appearance',
    'Providers',
    'Execution',
    'Tools',
    'Credentials',
  ]);
  assert.equal(activeRow(opened), 'Providers');
});

test('the Profile section saves a name and a time zone, and shows them when the window opens again', async () => {
  const stateful = host();
  opened = await openSettingsWindow({
    url: 'doric://app/settings/profile',
    host: stateful,
  });
  await settle(20);

  assert.equal(heading(opened), 'Profile');
  type(field(opened, 'profile-name'), 'Ana');
  await settle();
  await choose(
    opened,
    field(opened, 'profile-timezone'),
    'Sao_Paulo',
    'America/Sao_Paulo',
  );
  await flush(opened);

  assert.deepEqual(savedProfile(opened), {
    name: 'Ana',
    timezone: 'America/Sao_Paulo',
  });

  await opened.close();
  opened = undefined;
  opened = await openSettingsWindow({
    url: 'doric://app/settings/profile',
    host: stateful,
  });
  await settle(20);

  assert.equal(field(opened, 'profile-name').value, 'Ana');
  assert.equal(field(opened, 'profile-timezone').value, 'America/Sao_Paulo');
});

test('choosing the host time zone saves a profile without one', async () => {
  opened = await openSettingsWindow({
    url: 'doric://app/settings/profile',
    host: host({
      ...configuration,
      profile: { name: 'Ana', timezone: 'America/Sao_Paulo' },
    }),
  });
  await settle(20);

  assert.equal(heading(opened), 'Profile');
  await choose(
    opened,
    field(opened, 'profile-timezone'),
    'Host',
    'Host time zone',
  );
  await flush(opened);

  assert.deepEqual(savedProfile(opened), { name: 'Ana' });
});

test('a nav row opens its section at its own path', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const tools = [
    ...opened.document.querySelectorAll('[data-sidebar="menu-button"]'),
  ].find((row) => row.textContent === 'Tools') as HTMLElement;
  tools.click();
  await settle(20);

  assert.equal(opened.window.location.pathname, '/settings/tools');
  assert.equal(heading(opened), 'Tools');
  assert.equal(activeRow(opened), 'Tools');
});

test('the search keeps the sections whose label or sentence matches', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const search = opened.document.querySelector(
    'input[aria-label="Search settings sections"]',
  ) as HTMLInputElement;

  type(search, 'turns');
  await settle();
  assert.deepEqual(navRows(opened), ['Execution']);
  // The section on screen stays, with no active row while the query lasts.
  assert.equal(heading(opened), 'Providers');

  type(search, 'nothing like this');
  await settle();
  assert.deepEqual(navRows(opened), []);
  assert.match(opened.document.body.textContent ?? '', /No sections match/);
});

test('closing the window within the debounce saves the pending change', async () => {
  opened = await openSettingsWindow({
    url: 'doric://app/settings/execution',
    host: host(),
  });
  await settle(20);

  const turns = opened.document.getElementById(
    'execution-max-turns',
  ) as HTMLInputElement;
  type(turns, '12');
  await settle();
  assert.equal(opened.received('host-config/v1.replace').length, 0);

  await opened.requestClose({ phase: 'close', forced: false, deadline: 0 });
  await opened.requestClose({
    phase: 'flush',
    forced: false,
    deadline: Date.now() + 1_500,
  });

  const saves = opened.received('host-config/v1.replace');
  assert.equal(saves.length, 1);
  const sent = saves[0]?.input as
    | { readonly execution: { readonly maxTurns: number } }
    | undefined;
  assert.equal(sent?.execution.maxTurns, 12);
});

// R-9.8: a section another bundle adds is a nav row in its order, headed by
// its own link's label and icon, and edits the window's one autosave draft
// through settings.config/v1, which the window's close still flushes.
test('a section another bundle adds is headed by its link and saves through the window draft', async () => {
  type Draft = { readonly execution: { readonly maxTurns: number } };
  let config:
    | {
        draft(): Draft | undefined;
        setDraft(update: (draft: Draft) => Draft): void;
      }
    | undefined;
  opened = await openSettingsWindow({
    url: 'doric://app/settings/git',
    host: host(),
    probe: {
      requires: [
        'ui/v1@^1.0.0',
        'navigation/v1@^1.0.0',
        'regions/v1@^1.0.0',
        'settings.config/v1@^1.0.0',
      ],
      activate: ({ services }) => {
        const ui = services.use(UiV1);
        ui.define(
          'probe-section',
          class extends HTMLElement {
            connectedCallback() {
              this.textContent = 'Probe content';
            }
          },
        );
        services.use(RegionsV1).add('settings.sections', {
          id: 'git',
          tag: 'settings-link',
          order: 45,
          props: {
            label: 'Git',
            path: '/settings/git',
            icon: 'git-branch',
            description: 'A section another bundle adds.',
          },
        });
        services.use(NavigationV1).register({
          path: '/settings/git',
          parent: '/settings',
          create: () => ui.create('probe-section'),
        });
        config = services.use(
          ref<NonNullable<typeof config>>('settings.config/v1'),
        );
        return () => undefined;
      },
    },
  });
  await settle(20);

  assert.equal(heading(opened), 'Git');
  assert.deepEqual(navRows(opened), [
    'Profile',
    'Appearance',
    'Providers',
    'Execution',
    'Tools',
    'Git',
    'Credentials',
  ]);
  assert.equal(activeRow(opened), 'Git');
  assert.match(opened.document.body.textContent ?? '', /Probe content/);
  assert.equal(config?.draft()?.execution.maxTurns, 32);

  config?.setDraft((draft) => ({
    ...draft,
    execution: { ...draft.execution, maxTurns: 12 },
  }));
  await settle();
  assert.equal(config?.draft()?.execution.maxTurns, 12);
  assert.equal(opened.received('host-config/v1.replace').length, 0);

  await opened.requestClose({ phase: 'close', forced: false, deadline: 0 });
  await opened.requestClose({
    phase: 'flush',
    forced: false,
    deadline: Date.now() + 1_500,
  });

  const saves = opened.received('host-config/v1.replace');
  assert.equal(saves.length, 1);
  const sent = saves[0]?.input as Draft | undefined;
  assert.equal(sent?.execution.maxTurns, 12);
});

/** The credentials section's text once `secrets/v1.list` answers `listed`. */
const credentialsSection = async (listed: unknown): Promise<string> => {
  opened = await openSettingsWindow({
    url: 'doric://app/settings/credentials',
    host: { ...host(), 'secrets/v1.list': () => listed },
  });
  await settle(20);
  assert.equal(heading(opened), 'Credentials');
  return opened.document.body.textContent ?? '';
};

test('the credentials section lists the credentials it manages and leaves other kinds out', async () => {
  const text = await credentialsSection([
    { id: token, kind: 'API_TOKEN', name: 'OpenRouter', hasSecret: true },
    {
      id: '00000000-0000-4000-8000-0000000000dd',
      kind: 'MCP_TOKEN',
      name: 'mcp:server',
      hasSecret: true,
    },
  ]);

  assert.match(text, /OpenRouter/);
  assert.doesNotMatch(text, /mcp:server/);
  assert.doesNotMatch(text, /Doric returned an invalid response\./);
});

test('a malformed credential of a managed kind still fails the list', async () => {
  for (const malformed of [
    { id: token, kind: 'API_TOKEN', name: 7, hasSecret: true },
    { id: token, kind: 42, name: 'Broken', hasSecret: true },
  ]) {
    const text = await credentialsSection([
      malformed,
      {
        id: '00000000-0000-4000-8000-000000000002',
        kind: 'API_TOKEN',
        name: 'OpenRouter',
        hasSecret: true,
      },
    ]);

    // The section draws no list error, so the failed list shows as the
    // valid entry beside the malformed one missing too.
    assert.doesNotMatch(text, /OpenRouter/);
    assert.match(text, /No credentials are stored yet\./);
    await opened?.close();
    opened = undefined;
  }
});

// The inset-card look (ui-redesign phase 3, Figma `36:22049`): the window is
// the `--sidebar` canvas; the title bar and the nav sit on it with no fill and
// no rule; the section and its footer are an inset card. The tables separate
// their header from the rows by spacing alone (S22, `27:14990`); the Providers
// and Credentials tables also draw no row dividers (G10, `27:15154`,
// `27:15667`), while the two model tables keep both rules (`29:8582`,
// `32:45370`).

const classesOf = (element: Element | null | undefined): string[] => [
  ...(element?.classList ?? []),
];

const openSection = async (window: SettingsWindow, label: string) => {
  const row = [
    ...window.document.querySelectorAll('[data-sidebar="menu-button"]'),
  ].find((entry) => entry.textContent === label) as HTMLElement;
  row.click();
  await settle(20);
};

/** Every table header on screen, as the classes it carries. */
const tableHeaders = (window: SettingsWindow): string[][] =>
  [...window.document.querySelectorAll('[data-slot="table-header"]')].map(
    classesOf,
  );

/** Every table body row on screen, as the classes it carries. */
const bodyRows = (window: SettingsWindow): string[][] =>
  [
    ...window.document.querySelectorAll(
      '[data-slot="table-body"] [data-slot="table-row"]',
    ),
  ].map(classesOf);

test('the window is one canvas: the title bar and the nav carry no fill and no rule', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const canvas = opened.document.querySelector('[data-slot="sidebar-wrapper"]');
  assert.ok(
    classesOf(canvas).includes('bg-sidebar'),
    'the canvas is --sidebar',
  );

  const bar = opened.document.querySelector('[data-slot="settings-title-bar"]');
  assert.ok(bar !== null, 'the window draws its title bar');
  assert.ok(
    !classesOf(bar).includes('bg-sidebar'),
    'the title bar is transparent',
  );

  const nav = opened.document.querySelector('[data-slot="sidebar"]');
  assert.ok(
    classesOf(nav).includes('bg-transparent'),
    'the nav is transparent',
  );
  assert.ok(!classesOf(nav).includes('bg-sidebar'), 'the nav has no fill');

  assert.equal(
    opened.document.querySelectorAll('[data-slot="separator"]').length,
    0,
    'no separator in the window',
  );
  const footers = [
    opened.document.querySelector('[data-slot="sidebar-footer"]'),
    opened.document.querySelector('main > footer'),
  ];
  for (const footer of footers) {
    assert.ok(footer !== null, 'the window draws both footers');
    assert.ok(
      !classesOf(footer).includes('border-t'),
      `no rule over ${classesOf(footer).join(' ')}`,
    );
  }
});

test('the section and its footer sit on an inset card', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const card = opened.document.querySelector('main');
  assert.ok(card !== null, 'the window draws its content');
  // The card: --background, radius 10, shadow-sm, no stroke.
  const classes = classesOf(card);
  for (const name of ['bg-background', 'rounded-xl', 'shadow-sm'])
    assert.ok(classes.includes(name), `${name} in ${classes.join(' ')}`);
  assert.ok(!classes.some((name) => name.startsWith('border')));
  assert.ok(card.querySelector('footer') !== null, 'the footer is on the card');
  // The row it stands in (Figma's Body): 8 px of canvas right and bottom, 0
  // left beside the nav and 8 px when the nav is hidden.
  const row = classesOf(card.parentElement);
  for (const name of ['pr-2', 'pb-2', 'pl-2', 'md:pl-0'])
    assert.ok(row.includes(name), `${name} in ${row.join(' ')}`);
});

test('the Providers and Credentials tables draw no header rule and no row dividers', async () => {
  opened = await openSettingsWindow({
    host: {
      ...host(),
      'secrets/v1.list': () => [
        { id: token, kind: 'API_TOKEN', name: 'OpenRouter', hasSecret: true },
      ],
    },
  });
  await settle(20);

  const providers = tableHeaders(opened);
  assert.equal(providers.length, 1, 'the Providers table');
  assert.ok(providers[0]?.includes('[&_tr]:border-b-0'));
  const providerRows = bodyRows(opened);
  assert.ok(providerRows.length > 0, 'the provider rows');
  for (const row of providerRows)
    assert.ok(row.includes('border-b-0'), `a divider in ${row.join(' ')}`);

  await openSection(opened, 'Credentials');
  const credentials = tableHeaders(opened);
  assert.equal(credentials.length, 1, 'the Credentials table');
  assert.ok(credentials[0]?.includes('[&_tr]:border-b-0'));
  const credentialRows = bodyRows(opened);
  assert.ok(credentialRows.length > 0, 'the credential rows');
  for (const row of credentialRows)
    assert.ok(row.includes('border-b-0'), `a divider in ${row.join(' ')}`);
});

test('the Providers table fixes its columns at 170, 130, fill, 110 and 79 px', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  const table = opened.document.querySelector('[data-slot="table"]');
  assert.ok(classesOf(table).includes('table-fixed'), 'a fixed table layout');
  const heads = [
    ...opened.document.querySelectorAll(
      '[data-slot="table-header"] [data-slot="table-head"]',
    ),
  ].map((head) => classesOf(head).filter((name) => /^w-/.test(name)));
  // Figma `27:15154`: Name 170, Kind 130, Address fills, Models 110, actions 79.
  assert.deepEqual(heads, [
    ['w-[170px]'],
    ['w-[130px]'],
    [],
    ['w-[110px]'],
    ['w-[79px]'],
  ]);
});

test("a provider's catalog picker draws its table with a header rule and row dividers", async () => {
  const picked = {
    ...openrouter,
    fields: [
      ...openrouter.fields,
      { key: 'modelsUrl', label: 'Models URL', kind: 'url', required: false },
    ],
  };
  opened = await openSettingsWindow({
    host: {
      ...host(),
      'models/v1.kinds': () => [picked],
      'models/v1.kind': () => picked,
      'models/v1.catalog': () => ({ status: 'read', models: [] }),
    },
  });
  await settle(20);

  const row = opened.document.querySelector(
    '[data-slot="table-body"] [data-slot="table-row"]',
  ) as HTMLElement | null;
  assert.ok(row !== null, 'the provider row');
  row.click();
  await settle(20);
  const trigger = [...opened.document.querySelectorAll('button')].find(
    (button) => button.textContent?.includes('1 offered'),
  );
  assert.ok(trigger !== undefined, 'the models picker');
  trigger.click();
  await settle(20);

  // Figma `32:45370` (in `33:4823`) draws the header rule and the dividers.
  const headers = tableHeaders(opened);
  assert.equal(headers.length, 1, 'the catalog table');
  assert.ok(!headers[0]?.includes('[&_tr]:border-b-0'));
  for (const row of bodyRows(opened))
    assert.ok(!row.includes('border-b-0'), `no divider in ${row.join(' ')}`);
});

// T-4.1.9: the Appearance section reads the theme each time it mounts and
// saves a choice through `doric.appearance/v1`, which the window answers
// through `doric.shell/v1` (`appearanceGet`, `appearanceSet`).

/** A promise the test settles. */
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

/** The app's answers to the window's appearance calls. */
const appearanceHost = (answers: {
  readonly get: () => unknown;
  readonly set?: (input: unknown) => unknown;
}) => ({
  ...host(),
  'doric.shell/v1.appearanceGet': answers.get,
  'doric.shell/v1.appearanceSet': answers.set ?? (() => undefined),
});

const refused = (message: string) => () => {
  throw { code: 'unavailable', message };
};

const openAppearance = async (
  answers: Parameters<typeof appearanceHost>[0],
): Promise<SettingsWindow> => {
  opened = await openSettingsWindow({
    url: 'doric://app/settings/appearance',
    host: appearanceHost(answers),
  });
  await settle(20);
  return opened;
};

/** The Theme field's tiles: name, whether checked, whether disabled. */
const tiles = (window: SettingsWindow) => {
  const group = window.document.querySelector('[role="radiogroup"]');
  return [
    ...(group?.querySelectorAll<HTMLElement>('[role="radio"]') ?? []),
  ].map((tile) => ({
    element: tile,
    name: tile.querySelector('[data-slot="theme-title"]')?.textContent ?? '',
    checked: tile.getAttribute('aria-checked') === 'true',
    disabled: tile.getAttribute('aria-disabled') === 'true',
  }));
};

const checkedTile = (window: SettingsWindow): string[] =>
  tiles(window)
    .filter((tile) => tile.checked)
    .map((tile) => tile.name);

const tile = (window: SettingsWindow, name: string): HTMLElement => {
  const found = tiles(window).find((entry) => entry.name === name);
  assert.ok(found, `no tile ${name}`);
  return found.element;
};

const text = (window: SettingsWindow): string =>
  window.document.body.textContent ?? '';

test('the Appearance section offers the three themes in a group named Theme', async () => {
  const window = await openAppearance({ get: () => ({ theme: 'dark' }) });

  assert.equal(heading(window), 'Appearance');
  assert.equal(activeRow(window), 'Appearance');
  const group = window.document.querySelector('[role="radiogroup"]');
  const labelledBy = group?.getAttribute('aria-labelledby') ?? '';
  assert.equal(
    window.document.getElementById(labelledBy)?.textContent,
    'Theme',
  );
  assert.deepEqual(
    tiles(window).map((entry) => entry.name),
    ['Dark (default)', 'Light', 'System'],
  );
  assert.match(text(window), /Earthy dark surfaces with a cream accent/);
  assert.match(text(window), /Warm light surfaces/);
  assert.match(text(window), /Follow the macOS appearance/);
  assert.deepEqual(checkedTile(window), ['Dark (default)']);
});

test('while the theme is read the tiles are disabled and none is selected', async () => {
  const window = await openAppearance({
    get: () => deferred<unknown>().promise,
  });

  assert.equal(tiles(window).length, 3);
  assert.ok(tiles(window).every((entry) => entry.disabled));
  assert.deepEqual(checkedTile(window), []);
});

test("the read theme's tile is selected and every tile is enabled", async () => {
  const window = await openAppearance({ get: () => ({ theme: 'light' }) });

  assert.deepEqual(checkedTile(window), ['Light']);
  assert.ok(tiles(window).every((entry) => !entry.disabled));
});

test('a failed read says so with the tiles enabled and none selected, and a saved choice selects its tile', async () => {
  const saved: unknown[] = [];
  const window = await openAppearance({
    get: refused('The appearance store is not open.'),
    set: (input) => {
      saved.push(input);
      return undefined;
    },
  });

  assert.match(text(window), /Could not read the appearance\./);
  assert.ok(tiles(window).every((entry) => !entry.disabled));
  assert.deepEqual(checkedTile(window), []);

  tile(window, 'System').click();
  await settle(20);

  assert.deepEqual(saved, [{ theme: 'system' }]);
  assert.deepEqual(checkedTile(window), ['System']);
  assert.doesNotMatch(text(window), /Could not read the appearance\./);
});

test('a failed save says so and keeps the selected tile', async () => {
  const window = await openAppearance({
    get: () => ({ theme: 'dark' }),
    set: refused('Could not save the appearance.'),
  });

  tile(window, 'Light').click();
  await settle(20);

  assert.match(text(window), /Could not save the appearance\. Try again\./);
  assert.deepEqual(checkedTile(window), ['Dark (default)']);
  assert.ok(tiles(window).every((entry) => !entry.disabled));
});

test('while a save is pending the tiles are disabled and the selection moves only when it resolves', async () => {
  const save = deferred<undefined>();
  const window = await openAppearance({
    get: () => ({ theme: 'dark' }),
    set: () => save.promise,
  });

  tile(window, 'Light').click();
  await settle(20);

  assert.ok(tiles(window).every((entry) => entry.disabled));
  assert.deepEqual(checkedTile(window), ['Dark (default)']);

  save.resolve(undefined);
  await settle(20);

  assert.deepEqual(checkedTile(window), ['Light']);
  assert.ok(tiles(window).every((entry) => !entry.disabled));
});
