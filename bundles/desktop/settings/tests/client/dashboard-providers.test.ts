// The Providers group of the /projects dashboard as the user meets it: the
// settings bundle draws one row per configured provider into the dashboard's
// side menu (`layout.dashboard.nav`) and a provider's page into the
// dashboard's main area (`layout.dashboard.page`), opened through
// `layout.dashboard/v1`. A probe bundle plays the layout: it provides that
// contract and mounts the two settings elements the way the layout's
// dashboard does, the nav element always and the page element while the page
// it names is the active one.

import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import {
  type Disposable,
  defineMethod,
  defineService,
  disposableSchema,
  functionSchema,
  NavigationV1,
  noInput,
  ref,
  type Services,
  UiV1,
} from 'bundle/contracts';
import { z } from 'zod';

import {
  type HostAnswer,
  openSettingsWindow,
  type ProbeBundle,
  type SettingsWindow,
  settle,
} from './support/window.js';

const PAGE_ID = 'settings.provider';

/** The stored credential the OpenRouter provider names. */
const openrouterToken = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'API_TOKEN',
  name: 'OpenRouter',
  hasSecret: true,
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

const openai = {
  id: 'openai',
  label: 'OpenAI compatible',
  description: 'Any OpenAI-compatible server.',
  fields: [{ key: 'endpoint', label: 'Endpoint', kind: 'url', required: true }],
  lists: [],
};

/** A kind the provider icon has no mark of its own for. */
const acme = {
  id: 'acme',
  label: 'Acme',
  description: 'A kind the dashboard draws as a server.',
  fields: [{ key: 'endpoint', label: 'Endpoint', kind: 'url', required: true }],
  lists: [],
};

/** OpenRouter (remote), an OpenAI-compatible local server, and an unknown kind. */
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
    {
      id: 'lmstudio',
      kind: 'openai',
      configuration: { endpoint: 'http://localhost:1234/v1' },
      models: [],
    },
    {
      id: 'acme',
      kind: 'acme',
      configuration: { endpoint: 'https://acme.example/v1' },
      models: [],
    },
  ],
  models: { execution: { providerId: 'openrouter', model: 'deepseek/v4' } },
  execution: { maxTurns: 32 },
};

/** A host with the configuration stored; a replace stores what it gets. */
const host = (): Record<string, HostAnswer> => {
  let revision = 1;
  let stored: unknown = configuration;

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
    'models/v1.kinds': () => [openrouter, openai, acme],
    'secrets/v1.list': () => [openrouterToken],
    'tools/v1.catalog': () => [],
  };
};

interface LayoutDashboard {
  active(): string | undefined;
  show(id: string): void;
  close(): void;
  subscribe(listener: () => void): Disposable;
}

const LayoutDashboardV1 = ref<LayoutDashboard>('layout.dashboard/v1');

/**
 * The layout's side of the dashboard: `layout.dashboard/v1` with the method
 * schemas the layout declares, the dashboard route mounting the Providers
 * group, and the provider page's host mounted while that page is active.
 */
const layoutProbe = () => {
  let active: string | undefined;
  const shown: string[] = [];
  const listeners = new Set<() => void>();
  let root: HTMLElement | undefined;
  let page: HTMLElement | undefined;
  let services: Services | undefined;

  const create = (tag: string): HTMLElement =>
    services?.use(UiV1).create(tag) as HTMLElement;

  const drawPage = (): void => {
    if (root === undefined) return;
    if (active === PAGE_ID && page === undefined) {
      page = create('settings-dashboard-provider');
      root.append(page);
    } else if (active !== PAGE_ID && page !== undefined) {
      page.remove();
      page = undefined;
    }
  };

  const change = (next: string | undefined): void => {
    if (active === next) return;
    active = next;
    drawPage();
    for (const listener of [...listeners]) listener();
  };

  const probe: ProbeBundle = {
    requires: ['ui/v1@^1.0.0', 'navigation/v1@^1.0.0'],
    provides: ['layout.dashboard/v1@1.0.0'],
    activate: (context) => {
      services = context.services;
      context.services.provide(
        defineService(LayoutDashboardV1, {
          active: defineMethod({
            input: noInput,
            output: z.string().optional(),
            execute: () => active,
          }),
          show: defineMethod({
            input: z.string().min(1),
            output: z.void(),
            execute: (id: string) => {
              shown.push(id);
              change(id);
            },
          }),
          close: defineMethod({
            input: noInput,
            output: z.void(),
            execute: () => change(undefined),
          }),
          subscribe: defineMethod({
            input: functionSchema<() => void>(),
            output: disposableSchema,
            execute: (listener: () => void) => {
              listeners.add(listener);
              return { dispose: () => listeners.delete(listener) };
            },
          }),
        }),
      );
      const route = context.services.use(NavigationV1).register({
        path: '/projects',
        create: () => {
          root = document.createElement('div');
          root.append(create('settings-dashboard-providers'));
          drawPage();
          return root;
        },
      });
      return () => route.dispose();
    },
  };

  return {
    probe,
    /** The pages `show` was asked for, in order. */
    shown: (): readonly string[] => [...shown],
    /** The layout closing the page, as the dashboard's own controls do. */
    close: (): void => services?.use(LayoutDashboardV1).close(),
  };
};

let opened: SettingsWindow | undefined;

afterEach(async () => {
  await opened?.close();
  opened = undefined;
});

const openDashboard = async () => {
  const layout = layoutProbe();
  opened = await openSettingsWindow({
    url: 'doric://app/projects',
    host: host(),
    probe: layout.probe,
  });
  await settle(20);
  return { window: opened, layout };
};

const rows = (window: SettingsWindow): HTMLElement[] => [
  ...window.document.querySelectorAll<HTMLElement>(
    'settings-dashboard-providers [data-sidebar="menu-button"]',
  ),
];

const rowNames = (window: SettingsWindow): string[] =>
  rows(window).map((row) => row.textContent?.trim() ?? '');

const rowOf = (window: SettingsWindow, name: string): HTMLElement => {
  const row = rows(window).find((item) => item.textContent?.trim() === name);
  assert.ok(row !== undefined, `No row is named ${name}.`);
  return row;
};

const activeRows = (window: SettingsWindow): string[] =>
  rows(window)
    .filter((row) => row.hasAttribute('data-active'))
    .map((row) => row.textContent?.trim() ?? '');

const pageHeading = (window: SettingsWindow): string | undefined =>
  window.document
    .querySelector('settings-dashboard-provider h1')
    ?.textContent?.trim() ?? undefined;

const field = (window: SettingsWindow, id: string): HTMLInputElement => {
  const input = window.document.getElementById(id);
  assert.ok(input !== null, `The page has no #${id} field.`);
  return input as HTMLInputElement;
};

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

type SentConfiguration = {
  readonly providers: readonly {
    readonly id: string;
    readonly configuration: Readonly<Record<string, string>>;
  }[];
};

/** Opens the dashboard with the page of the provider row named `name`. */
const openProviderPage = async (name: string) => {
  const dashboard = await openDashboard();
  rowOf(dashboard.window, name).click();
  await settle(20);
  return dashboard;
};

test('the Providers group lists every configured provider by its name and mark', async () => {
  const { window } = await openDashboard();

  const labels = [
    ...window.document.querySelectorAll(
      'settings-dashboard-providers [data-sidebar="group-label"]',
    ),
  ].map((label) => label.textContent?.trim());
  assert.deepEqual(labels, ['Providers']);
  assert.deepEqual(rowNames(window), ['openrouter', 'lmstudio', 'acme']);

  const local = rowOf(window, 'lmstudio');
  assert.ok(
    local.querySelector('svg.lucide-monitor') !== null,
    'The local provider is not drawn as a local machine.',
  );
  const unknown = rowOf(window, 'acme');
  assert.ok(
    unknown.querySelector('svg.lucide-server') !== null,
    'The unknown kind is not drawn as a server.',
  );
  const remote = rowOf(window, 'openrouter');
  assert.ok(
    remote.querySelector('svg') !== null &&
      remote.querySelector('svg.lucide-monitor, svg.lucide-server') === null,
    'OpenRouter is not drawn by its own mark.',
  );
});

test('a provider row opens its page in the dashboard and is the active row', async () => {
  const { window, layout } = await openProviderPage('openrouter');

  assert.deepEqual(layout.shown(), [PAGE_ID]);
  assert.equal(pageHeading(window), 'openrouter');
  assert.deepEqual(activeRows(window), ['openrouter']);
  assert.equal(field(window, 'provider-name').value, 'openrouter');
  assert.equal(
    field(window, 'provider-endpoint').value,
    'https://openrouter.ai/api/v1',
  );
});

test("the OpenRouter page opens the provider's site in the browser; other kinds offer none", async () => {
  const { window } = await openProviderPage('openrouter');

  const site = window.document.querySelector<HTMLElement>(
    'settings-dashboard-provider [aria-label="Open OpenRouter"]',
  );
  assert.ok(site !== null, 'The OpenRouter page offers no site link.');
  site.click();
  await settle(20);
  assert.deepEqual(
    window.received('doric.shell/v1.openExternal').map((call) => call.input),
    [{ url: 'https://openrouter.ai' }],
  );

  rowOf(window, 'lmstudio').click();
  await settle(20);
  assert.equal(pageHeading(window), 'lmstudio');
  assert.ok(
    window.document.querySelector(
      'settings-dashboard-provider [aria-label="Open OpenRouter"]',
    ) === null,
    'An OpenAI-compatible page still offers the OpenRouter site.',
  );
});

test('a change on the provider page saves itself once typing settles', async () => {
  const { window } = await openProviderPage('openrouter');

  type(field(window, 'provider-endpoint'), 'https://openrouter.ai/api/v2');
  await settle(800);

  const saves = window.received('host-config/v1.replace');
  assert.equal(saves.length, 1);
  const sent = saves[0]?.input as SentConfiguration | undefined;
  assert.equal(
    sent?.providers.find((provider) => provider.id === 'openrouter')
      ?.configuration.endpoint,
    'https://openrouter.ai/api/v2',
  );
});

test('renaming a provider on its page renames its row', async () => {
  const { window } = await openProviderPage('lmstudio');

  type(field(window, 'provider-name'), 'studio');
  await settle(20);

  assert.deepEqual(rowNames(window), ['openrouter', 'studio', 'acme']);
  assert.equal(pageHeading(window), 'studio');
});

test('closing the window within the debounce saves the pending provider change', async () => {
  const { window } = await openProviderPage('openrouter');

  type(field(window, 'provider-endpoint'), 'https://openrouter.ai/api/v2');
  await settle();
  assert.equal(window.received('host-config/v1.replace').length, 0);

  await window.requestClose({ phase: 'close', forced: false, deadline: 0 });
  await window.requestClose({
    phase: 'flush',
    forced: false,
    deadline: Date.now() + 1_500,
  });

  const saves = window.received('host-config/v1.replace');
  assert.equal(saves.length, 1);
  const sent = saves[0]?.input as SentConfiguration | undefined;
  assert.equal(
    sent?.providers.find((provider) => provider.id === 'openrouter')
      ?.configuration.endpoint,
    'https://openrouter.ai/api/v2',
  );
});

test('the add-provider action opens a new provider page with its kind picker', async () => {
  const { window, layout } = await openDashboard();

  const add = window.document.querySelector<HTMLElement>(
    'settings-dashboard-providers [aria-label="Add provider"]',
  );
  assert.ok(add !== null, 'The Providers group offers no add action.');
  assert.equal(add.getAttribute('title'), 'Add provider');
  add.click();
  await settle(20);

  assert.deepEqual(layout.shown(), [PAGE_ID]);
  assert.equal(pageHeading(window), 'Add provider');
  assert.ok(
    window.document.getElementById('provider-kind') !== null,
    'The new provider page shows no kind picker.',
  );
});

test('the dashboard closing the page leaves no provider open', async () => {
  const { window, layout } = await openProviderPage('openrouter');
  assert.deepEqual(activeRows(window), ['openrouter']);

  layout.close();
  await settle(20);

  assert.deepEqual(activeRows(window), []);
  assert.equal(pageHeading(window), undefined);
  assert.ok(
    window.document.getElementById('provider-name') === null,
    'The provider form is still drawn after the page closed.',
  );
});
