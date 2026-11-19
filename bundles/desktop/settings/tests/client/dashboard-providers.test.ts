// The Providers group of the /projects dashboard as the user meets it: the
// settings bundle draws one row per configured provider into the dashboard's
// side menu (`workspace.dashboard.nav`) and a provider's page into the
// dashboard's main area (`workspace.dashboard.page`), opened through
// `workspace.dashboard/v1`. A probe bundle plays `workspace`: it provides
// that contract and mounts the two settings elements the way the workspace's
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
  announced,
  noticesIn,
  retryOf,
  type Toasts,
  titleOf,
  windowToasts,
} from './support/notices.js';
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
  site: { url: 'https://openrouter.ai', label: 'Open OpenRouter' },
};

const openai = {
  id: 'openai',
  label: 'OpenAI compatible',
  description: 'Any OpenAI-compatible server.',
  fields: [{ key: 'endpoint', label: 'Endpoint', kind: 'url', required: true }],
  lists: [],
};

/** A kind the host answers no icon for. */
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

/**
 * The SVG the host answers for OpenRouter's own icon. Its unique `id` tells
 * whether any of its markup reached the document.
 */
const openrouterSvg =
  '<svg id="fixture-icon-openrouter" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></svg>';

type IconsInput = {
  readonly requests: readonly {
    readonly kind: string;
    readonly models: readonly string[];
  }[];
};

/**
 * `models/v1.icons` as the host answers it: an own icon for an `openrouter`
 * provider and none for any other kind, nor for any model.
 */
const answerIcons = (input: unknown) => {
  const { requests } = input as IconsInput;
  return {
    svgs: { openrouter: openrouterSvg },
    answers: requests.map((request) => ({
      ...(request.kind === 'openrouter' ? { provider: 'openrouter' } : {}),
      models: request.models.map(() => null),
    })),
  };
};

/** A host with the configuration stored; a replace stores what it gets. */
const host = (initial: unknown = configuration): Record<string, HostAnswer> => {
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
    'models/v1.kinds': () => [openrouter, openai, acme],
    'models/v1.icons': answerIcons,
    'secrets/v1.list': () => [openrouterToken],
    'tools/v1.catalog': () => [],
  };
};

interface WorkspaceDashboard {
  active(): string | undefined;
  show(id: string): void;
  close(): void;
  subscribe(listener: () => void): Disposable;
}

const WorkspaceDashboardV1 = ref<WorkspaceDashboard>('workspace.dashboard/v1');

/**
 * The workspace's side of the dashboard: `workspace.dashboard/v1` with the
 * method schemas `workspace` declares, the dashboard route mounting the Providers
 * group, and the provider page's host mounted while that page is active.
 */
/** The part of `settings.models/v1` T-40 reads, by id as the chat reads it. */
interface SettingsModels {
  view(): {
    readonly status: string;
    readonly listsModels?: boolean;
    readonly groups?: readonly {
      readonly choices: readonly { readonly label: string }[];
    }[];
  };
  subscribe(listener: () => void): Disposable;
}

const SettingsModelsV1 = ref<SettingsModels>('settings.models/v1');

/**
 * `workspace`'s side of the dashboard; with `models`, the probe also plays the
 * chat's footer picker in the same window: it requires `settings.models/v1`.
 */
const dashboardProbe = (options: { readonly models?: boolean } = {}) => {
  let active: string | undefined;
  let models: SettingsModels | undefined;
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
    requires: [
      'ui/v1@^1.0.0',
      'navigation/v1@^1.0.0',
      ...(options.models === true ? ['settings.models/v1@^1.0.0'] : []),
    ],
    provides: ['workspace.dashboard/v1@1.0.0'],
    activate: (context) => {
      services = context.services;
      if (options.models === true) {
        models = context.services.use(SettingsModelsV1);
      }
      context.services.provide(
        defineService(WorkspaceDashboardV1, {
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
    /** `workspace` closing the page, as the dashboard's own controls do. */
    close: (): void => services?.use(WorkspaceDashboardV1).close(),
    /** `settings.models/v1` as the probe received it, with `models`. */
    models: (): SettingsModels | undefined => models,
  };
};

let opened: SettingsWindow | undefined;
/** The toasts of the window a T-38 test opened, dismissed before it closes. */
let toasts: Toasts | undefined;

afterEach(async () => {
  toasts?.dismissAll();
  toasts = undefined;
  await opened?.close();
  opened = undefined;
});

const openDashboard = async (
  options: {
    readonly models?: boolean;
    readonly stored?: unknown;
    /** Host answers over the defaults. */
    readonly answers?: Readonly<Record<string, HostAnswer>>;
  } = {},
) => {
  const dashboard = dashboardProbe(options);
  opened = await openSettingsWindow({
    url: 'doric://app/projects',
    host: { ...host(options.stored), ...options.answers },
    probe: dashboard.probe,
  });
  await settle(20);
  return { window: opened, dashboard };
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

test("the Providers group draws the host's icon for a provider, a server for one it answers none, and no inline brand path", async () => {
  const { window } = await openDashboard();
  await settle(20);

  const labels = [
    ...window.document.querySelectorAll(
      'settings-dashboard-providers [data-sidebar="group-label"]',
    ),
  ].map((label) => label.textContent?.trim());
  assert.deepEqual(labels, ['Providers']);
  assert.deepEqual(rowNames(window), ['openrouter', 'lmstudio', 'acme']);

  const icon = rowOf(window, 'openrouter').querySelector<HTMLElement>(
    '[data-slot="model-icon"]',
  );
  assert.ok(icon !== null, "OpenRouter does not draw the host's icon.");
  assert.match(icon.style.mask, /data:image\/svg\+xml/);

  // The host answers no own icon for these, a local endpoint included.
  for (const name of ['lmstudio', 'acme']) {
    assert.ok(
      rowOf(window, name).querySelector('svg.lucide-server') !== null,
      `${name} is not drawn as a server.`,
    );
  }

  for (const row of rows(window)) {
    assert.equal(
      row.querySelector('svg:not(.lucide) path'),
      null,
      `${row.textContent?.trim()} draws an inline brand path.`,
    );
  }
  // The SVG reaches only a mask's URL, never the document.
  assert.equal(window.document.getElementById('fixture-icon-openrouter'), null);
});

test('a provider row opens its page in the dashboard and is the active row', async () => {
  const { window, dashboard } = await openProviderPage('openrouter');

  assert.deepEqual(dashboard.shown(), [PAGE_ID]);
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

/** The page of the provider `name`, with the kinds the host answers. */
const openPageWithKinds = async (name: string, kinds: readonly unknown[]) => {
  const dashboard = await openDashboard({
    answers: { 'models/v1.kinds': () => kinds },
  });
  rowOf(dashboard.window, name).click();
  await settle(20);
  return dashboard;
};

const headerButtons = (window: SettingsWindow): HTMLElement[] => [
  ...window.document.querySelectorAll<HTMLElement>(
    'settings-dashboard-provider header button',
  ),
];

test("T6.2: a kind's descriptor names the site its page opens and the control's label, for a kind settings never named", async () => {
  const { window } = await openPageWithKinds('acme', [
    openrouter,
    openai,
    { ...acme, site: { url: 'https://acme.test/console', label: 'Open Acme' } },
  ]);

  const site = window.document.querySelector<HTMLElement>(
    'settings-dashboard-provider [aria-label="Open Acme"]',
  );
  assert.ok(site !== null, 'The Acme page offers no site link.');
  site.click();
  await settle(20);
  assert.deepEqual(
    window.received('doric.shell/v1.openExternal').map((call) => call.input),
    [{ url: 'https://acme.test/console' }],
  );
});

test('T6.2: a kind whose site is not https draws no site control on its page', async () => {
  const { window } = await openPageWithKinds('acme', [
    openrouter,
    openai,
    {
      ...acme,
      site: { url: 'http://insecure.test', label: 'Open Insecure' },
    },
  ]);

  assert.equal(pageHeading(window), 'acme');
  assert.deepEqual(headerButtons(window), []);
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

test("a model the provider page adds reaches settings.models/v1's groups without a window focus, and its subscribers are called (T-40)", async () => {
  // No provider lists a model, so the view asks for a typed model; the
  // default runs on a typed model of the local server.
  const stored = {
    ...configuration,
    providers: configuration.providers.map((provider) => ({
      ...provider,
      models: [],
    })),
    models: { execution: { providerId: 'lmstudio', model: 'local-1' } },
  };
  const { window, dashboard } = await openDashboard({ models: true, stored });
  const models = dashboard.models();
  assert.ok(
    models !== undefined,
    'No provider of settings.models/v1 reached a bundle that requires it.',
  );
  let heard = 0;
  const subscription = models.subscribe(() => {
    heard += 1;
  });
  await settle(20);
  rowOf(window, 'openrouter').click();
  await settle(20);

  const before = models.view();
  assert.equal(before.status, 'ready');
  assert.equal(before.listsModels, false);
  heard = 0;

  const add = [
    ...window.document.querySelectorAll<HTMLElement>(
      'settings-dashboard-provider button',
    ),
  ].find((button) => button.textContent?.trim() === 'Add model');
  assert.ok(add !== undefined, 'The provider page offers no Add model.');
  add.click();
  await settle(20);
  const name = window.document.querySelector<HTMLInputElement>(
    'settings-dashboard-provider [aria-label="Model 1"]',
  );
  assert.ok(name !== null, 'The added model has no name field.');
  type(name, 'deepseek/v4');
  await settle(800);
  assert.equal(window.received('host-config/v1.replace').length, 1);
  await settle(20);

  // The provider now lists a model: the view's groups hold it, and it got
  // there with no window focus (the test dispatches none).
  const after = models.view();
  assert.equal(after.status, 'ready');
  assert.equal(after.listsModels, true);
  assert.ok(
    (after.groups ?? []).some((group) =>
      group.choices.some((choice) => choice.label === 'deepseek/v4'),
    ),
    'The added model is not among the groups.',
  );
  assert.ok(heard > 0, 'No subscriber heard the saved configuration.');
  subscription.dispose();
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
  const { window, dashboard } = await openDashboard();

  const add = window.document.querySelector<HTMLElement>(
    'settings-dashboard-providers [aria-label="Add provider"]',
  );
  assert.ok(add !== null, 'The Providers group offers no add action.');
  assert.equal(add.getAttribute('title'), 'Add provider');
  add.click();
  await settle(20);

  assert.deepEqual(dashboard.shown(), [PAGE_ID]);
  assert.equal(pageHeading(window), 'Add provider');
  assert.ok(
    window.document.getElementById('provider-kind') !== null,
    'The new provider page shows no kind picker.',
  );
});

test('the dashboard closing the page leaves no provider open', async () => {
  const { window, dashboard } = await openProviderPage('openrouter');
  assert.deepEqual(activeRows(window), ['openrouter']);

  dashboard.close();
  await settle(20);

  assert.deepEqual(activeRows(window), []);
  assert.equal(pageHeading(window), undefined);
  assert.ok(
    window.document.getElementById('provider-name') === null,
    'The provider form is still drawn after the page closed.',
  );
});

test("the provider page's header draws no rule under it; the dashboard's card holds the page", async () => {
  const { window } = await openProviderPage('openrouter');

  const header = window.document.querySelector(
    'settings-dashboard-provider header',
  );
  assert.ok(header !== null, 'The page draws no header.');
  const classes = [...header.classList];
  // Figma `36:22108` PageHeader: h56, px24, gap 8, --background, no stroke.
  for (const name of ['h-14', 'px-6', 'gap-2', 'bg-background'])
    assert.ok(classes.includes(name), `${name} in ${classes.join(' ')}`);
  assert.ok(
    !classes.some((name) => name.startsWith('border')),
    `a rule in ${classes.join(' ')}`,
  );
});

test("the Providers group follows the Projects group's metrics: no inset, a 20 px label, 28 px rows", async () => {
  const { window } = await openDashboard();

  const group = window.document.querySelector(
    'settings-dashboard-providers [data-sidebar="group"]',
  );
  assert.ok(group !== null, 'the Providers group');
  const groupClasses = [...group.classList];
  // The prototype's Projects group (`85:7520`): no padding, 4 px under the label.
  for (const name of ['p-0', 'gap-1'])
    assert.ok(
      groupClasses.includes(name),
      `${name} in ${groupClasses.join(' ')}`,
    );

  const label = group.querySelector('[data-sidebar="group-label"]');
  const labelClasses = [...(label?.classList ?? [])];
  for (const name of ['h-5', 'pl-1.5', 'gap-1'])
    assert.ok(
      labelClasses.includes(name),
      `${name} in ${labelClasses.join(' ')}`,
    );

  const action = group.querySelector('[data-sidebar="group-action"]');
  const actionClasses = [...(action?.classList ?? [])];
  for (const name of ['top-0', 'right-1'])
    assert.ok(
      actionClasses.includes(name),
      `${name} in ${actionClasses.join(' ')}`,
    );

  const drawn = rows(window);
  assert.ok(drawn.length > 0, 'the provider rows');
  for (const row of drawn) {
    const classes = [...row.classList];
    for (const name of ['h-7', 'gap-1.5', 'px-1.5', 'py-0', 'text-[13px]'])
      assert.ok(classes.includes(name), `${name} in ${classes.join(' ')}`);
  }
});

// T-38 (error-messages.md §5.2): the dashboard's failure surfaces. The
// Providers group draws a failed provider kinds read, else a failed
// credentials list read, as one compact, announced notice after its rows,
// whose Retry reads that list again; the provider page's open-site failure
// toasts as `provider-open-site`. A host failure the test throws reaches the
// window as code `internal`, which the notices skip for their fallback code.

const hostDown = (): never => {
  throw new Error('The host store is locked.');
};

const groupNotices = (window: SettingsWindow): HTMLElement[] =>
  noticesIn(window.document.querySelector('settings-dashboard-providers'));

test('the Providers group shows a failed kinds read, then a failed credentials read, as one compact notice whose Retry reads again (T-38)', async () => {
  let kindsDown = true;
  let credentialsDown = true;
  const { window } = await openDashboard({
    answers: {
      'models/v1.kinds': () =>
        kindsDown ? hostDown() : [openrouter, openai, acme],
      'secrets/v1.list': () =>
        credentialsDown ? hostDown() : [openrouterToken],
    },
  });

  // Both failed: the kinds read is the one the group names.
  let notices = groupNotices(window);
  assert.equal(notices.length, 1, 'the group draws no single notice');
  let notice = notices[0] as HTMLElement;
  assert.equal(titleOf(notice), 'Providers not loaded');
  assert.equal(notice.getAttribute('data-variant'), 'compact');
  assert.equal(announced(notice), true);
  let retry = retryOf(notice);
  assert.ok(retry, 'the failed kinds read offers no Retry');

  kindsDown = false;
  retry.click();
  await settle(40);

  // The kinds arrived; the credentials list is still the failed read.
  notices = groupNotices(window);
  assert.equal(notices.length, 1, 'the group draws no single notice');
  notice = notices[0] as HTMLElement;
  assert.equal(titleOf(notice), 'Credentials not loaded');
  retry = retryOf(notice);
  assert.ok(retry, 'the failed credentials read offers no Retry');

  credentialsDown = false;
  retry.click();
  await settle(40);
  assert.deepEqual(groupNotices(window), []);
  assert.ok(rowNames(window).includes('openrouter'));
});

test('a failed open-site toasts as provider-open-site, titled "Page not opened" (T-38)', async () => {
  const { window } = await openDashboard({
    answers: {
      'doric.shell/v1.openExternal': () => {
        throw new Error('No browser is installed.');
      },
    },
  });
  toasts = await windowToasts(window.document, { mount: true });
  rowOf(window, 'openrouter').click();
  await settle(20);

  const site = window.document.querySelector<HTMLElement>(
    'settings-dashboard-provider [aria-label="Open OpenRouter"]',
  );
  assert.ok(site !== null, 'The OpenRouter page offers no site link.');
  site.click();
  await settle(40);

  assert.ok(toasts.ids().includes('provider-open-site'));
  const surfaces = toasts.surfaces();
  assert.equal(surfaces.length, 1, 'one failure toast is drawn');
  const notice = noticesIn(surfaces[0])[0];
  assert.ok(notice, 'the toast holds no notice');
  assert.equal(titleOf(notice), 'Page not opened');
});
