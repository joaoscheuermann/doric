// The settings window as the user meets it: opened at `/settings`, the nav
// of its own four sections (Versioning is the git bundle's, WP-10N), each
// section a route, the search, and the save the
// window's close waits for.

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
const host = () => {
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
  window.document.querySelector(
    '[data-sidebar="menu-button"][data-active="true"]',
  )?.textContent ?? undefined;

const type = (input: HTMLInputElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
};

test('a window opened at /settings shows the Providers section and names itself', async () => {
  opened = await openSettingsWindow({ host: host() });
  await settle(20);

  assert.equal(opened.window.location.pathname, '/settings/providers');
  assert.equal(opened.document.title, 'Doric Settings');
  assert.equal(heading(opened), 'Providers');
  assert.deepEqual(navRows(opened), [
    'Providers',
    'Execution',
    'Tools',
    'Credentials',
  ]);
  assert.equal(activeRow(opened), 'Providers');
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
